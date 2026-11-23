/*
 * SiliconedBridgeToolbar.mm — 原生浮窗任务栏（选区上下文任务栏的去 UXP 化实现）
 *
 * 目标（解决 UXP <dialog> 的三个硬伤）：
 *   1. 无系统标题栏      —— NSPanel + Borderless 样式，内容完全自绘；
 *   2. 出现即精确定位    —— showToolbar 可传全局屏幕坐标锚点（top-left 原点，
 *                            点）：JS 按选区算好目标位置，native 转 Cocoa
 *                            bottom-left 坐标后创建即 setFrame，不经过
 *                            「先居中再挪」的闪烁；屏幕兜底钳制进 visibleFrame；
 *   3. 不抢 PS 焦点      —— NSWindowStyleMaskNonactivatingPanel。
 *
 * 架构（JS 是唯一状态源，native 无状态逻辑，UI = f(state)）：
 *   showToolbar({width,height})   —— 显示/重定位浮窗（创建即在目标位置）
 *   hideToolbar()                 —— 收起（复用窗口不销毁）
 *   setToolbarState(state)        —— JS 推送 UI 状态：{mode,status,statusError,
 *                                     busy,placeholder,value}，字段缺省=不变化
 *   waitToolbarEvent()            —— Promise<event>：click{id} / input{value}
 *                                     （逐键）/ error{message}
 *
 * 线程模型（POC 真机教训）：
 *   - hybrid dylib 与 PS 主进程同进程；AppKit 窗口/视图状态归宿主主线程，
 *     全部窗口与视图操作 dispatch 到 dispatch_get_main_queue()（后台线程
 *     开窗直接打崩 PS —— v1 教训）；
 *   - schedule_on_javascript_queue 只从普通后台线程调用；主线程产生的事件
 *     先转交常驻 relay 线程（复刻 runCommand 模式 —— v2/v3 教训）；
 *   - schedule 路径的 task 由 deleter 释放，回调不得 delete（双重释放打崩
 *     UXP JS 线程 —— v2/v3 教训）。
 *
 * 实验性：官方只承诺 hybrid 做「计算/逻辑」，画 UI 属未支持路径。
 * 若 PS 大版本更新破坏此机制，回退 UXP dialog 方案。
 */
#import <AppKit/AppKit.h>
#import <QuartzCore/QuartzCore.h>

#include <algorithm>
#include <cmath>
#include <condition_variable>
#include <deque>
#include <mutex>
#include <string>
#include <thread>

#include "SiliconedBridge.h"

// ---------------------------------------------------------------- 布局常量
// 窗口 380x56：左侧拖动把手 + 主行（按钮行 / 输入行，垂直居中）+ 底部状态行
// （Cocoa 左下原点）。状态行贴底悬浮，不影响主行居中。

namespace {

constexpr double kWidth = 380;
constexpr double kHeight = 30;
constexpr double kHandleW = 20;  // 左侧拖动把手宽度
constexpr double kMarginL = 28;  // 主行左缘（把手 + 内边距）
constexpr double kMarginR = 8;
constexpr double kGap = 8;
constexpr double kRowY = 4;   // (kHeight - kRowH) / 2 —— 上下留白相等
constexpr double kRowH = 30;
constexpr double kStatusY = 1;
constexpr double kStatusH = 12;

/** JS 推送的 UI 状态（字段缺省 = 不变化；由 setToolbarState 解析填充） */
struct ToolbarUiState {
    bool hasMode = false;
    bool inputMode = false;     // true = input 态，false = buttons 态
    bool bannerMode = false;    // true = 横幅态（入队成功反馈，覆盖整窗）
    bool hasStatus = false;
    std::string status;
    bool statusError = false;
    bool hasBusy = false;
    bool busy = false;
    bool hasFadeOut = false;
    bool fadeOut = false;       // 横幅淡出并自动收起（动画完成后 native orderOut）
    bool hasPlaceholder = false;
    std::string placeholder;
    bool hasValue = false;
    std::string value;
};

// ---------------------------------------------------------------- 事件回传

struct EventTask {
    addon_env env = nullptr;
    addon_deferred deferred = nullptr;
    std::string json;
};

/**
 * 回到 JS 线程后 resolve 挂起的 Promise（与 RunCommandTask 同模式）。
 * 注意：只负责 resolve，不释放 task —— schedule 路径的 task 由 deleter 释放，
 * 回调里再 delete 会双重释放（实测 malloc abort 直接打崩 UXP JS 线程）。
 */
void ResolveEventTask(addon_task_data data) {
    EventTask* task = static_cast<EventTask*>(data);
    if (task == nullptr) {
        return;
    }
    try {
        HandlerScope scope(task->env);
        addon_value strVal = nullptr;
        if (UxpAddonApis.uxp_addon_create_string_utf8(task->env, task->json.c_str(),
                                                      task->json.size(), &strVal) == addon_ok &&
            strVal != nullptr) {
            addon_value obj = nullptr;
            if (UxpAddonApis.uxp_addon_create_object(task->env, &obj) == addon_ok && obj != nullptr) {
                UxpAddonApis.uxp_addon_set_named_property(task->env, obj, "raw", strVal);
                UxpAddonApis.uxp_addon_resolve_deferred(task->env, task->deferred, obj);
            }
        }
    } catch (...) {
        std::fprintf(stderr, "[SiliconedBridge] failed to resolve toolbar event\n");
    }
}

/** 保护事件队列与挂起 Promise（relay 线程产生 / JS 线程消费） */
std::mutex gMutex;

/** 待取事件（JSON 字符串），relay 线程产生、JS 线程消费 */
std::deque<std::string> gEvents;

/** waitToolbarEvent 挂起的 Promise；事件到达时在 relay 线程 resolve */
addon_env gPendingEnv = nullptr;
addon_deferred gPendingDeferred = nullptr;

/** 主线程产生事件：有挂起 Promise 就立即回传，否则入队等 JS 下次来取 */
void PushEvent(std::string json) {
    addon_env env = nullptr;
    addon_deferred deferred = nullptr;
    {
        std::lock_guard<std::mutex> lock(gMutex);
        if (gPendingDeferred == nullptr) {
            if (gEvents.size() > 64) {
                gEvents.pop_front();  // 防御：JS 长期不取时丢最旧
            }
            gEvents.push_back(json);
            return;
        }
        env = gPendingEnv;
        deferred = gPendingDeferred;
        gPendingEnv = nullptr;
        gPendingDeferred = nullptr;
    }
    auto* task = new EventTask{env, deferred, std::move(json)};
    UxpAddonApis.uxp_addon_schedule_on_javascript_queue(env, ResolveEventTask, task,
                                                        [](addon_task_data d) {
                                                            delete static_cast<EventTask*>(d);
                                                        });
}

/**
 * 常驻事件 relay 线程：AppKit 主线程（按钮/输入事件）不直接调
 * schedule_on_javascript_queue，而是把 JSON 丢进来，由这个普通后台线程
 * 转交给 PushEvent（复刻 runCommand 已验证的线程模式）。
 */
class EventRelay {
public:
    void push(std::string json) {
        start();  // 惰性启动（v5 初版漏调 start，relay 线程从未运行，事件滞留队列 → 按钮全部无效）
        {
            std::lock_guard<std::mutex> lock(m_);
            queue_.push_back(std::move(json));
        }
        cv_.notify_one();
    }

    void start() {
        std::call_once(started_, [this]() {
            std::thread([this]() {
                for (;;) {
                    std::string json;
                    {
                        std::unique_lock<std::mutex> lock(m_);
                        cv_.wait(lock, [this]() { return !queue_.empty(); });
                        json = std::move(queue_.front());
                        queue_.pop_front();
                    }
                    PushEvent(std::move(json));
                }
            }).detach();
        });
    }

private:
    std::mutex m_;
    std::condition_variable cv_;
    std::deque<std::string> queue_;
    std::once_flag started_;
};

EventRelay& Relay() {
    static EventRelay relay;
    return relay;
}

/** 主线程事件入口：转交 relay 线程（惰性启动） */
void PushEventFromMainThread(std::string json) {
    Relay().push(std::move(json));
}

/** 事件 value 需 JSON 转义（提示词可能含引号/换行） */
std::string JsonEscape(const std::string& s) {
    std::string out;
    out.reserve(s.size() + 8);
    char buf[8];
    for (unsigned char c : s) {
        switch (c) {
            case '"': out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\b': out += "\\b"; break;
            case '\f': out += "\\f"; break;
            case '\n': out += "\\n"; break;
            case '\r': out += "\\r"; break;
            case '\t': out += "\\t"; break;
            default:
                if (c < 0x20) {
                    std::snprintf(buf, sizeof(buf), "\\u%04x", c);
                    out += buf;
                } else {
                    out += static_cast<char>(c);
                }
        }
    }
    return out;
}

/** 浮窗：仅在主线程（dispatch_get_main_queue 块内）读写 */
NSPanel* gPanel = nullptr;

}  // namespace

// ---------------------------------------------------------------- 浮窗内容
// ObjC 类不能放在匿名 namespace 里，视图类定义在全局作用域（文件私有）；
// 它引用的 PushEventFromMainThread 等在上方匿名 namespace 内，同文件可见。

/** 左侧拖动把手：三条握持条 + 整块区域可拖拽窗口（交给 AppKit 拖拽循环） */
@interface ToolbarHandleView : NSView
@end

@implementation ToolbarHandleView

- (void)drawRect:(NSRect)dirtyRect {
    (void)dirtyRect;
    NSColor* color = [NSColor colorWithCalibratedWhite:1.0 alpha:0.25];
    CGFloat w = 10, h = 2, gap = 3;
    CGFloat x = self.bounds.size.width / 2.0 - w / 2.0;
    // 视觉修正：居中值上移 2px（几何居中因字形基线观感偏低）
    CGFloat y0 = self.bounds.size.height / 2.0 - (3 * h + 2 * gap) / 2.0 + 2.0;
    NSBezierPath* path = [NSBezierPath bezierPathWithRect:NSMakeRect(x, y0, w, h)];
    [path appendBezierPath:[NSBezierPath bezierPathWithRect:NSMakeRect(x, y0 + h + gap, w, h)]];
    [path appendBezierPath:[NSBezierPath bezierPathWithRect:NSMakeRect(x, y0 + 2 * (h + gap), w, h)]];
    [color setFill];
    [path fill];
}

- (void)mouseDown:(NSEvent*)event {
    // 无边框窗口的标准拖拽入口：交给 AppKit 的窗口拖拽循环，松开即结束
    [self.window performWindowDragWithEvent:event];
}

@end

/**
 * 入队成功横幅：铺满整窗的背景层 + drawRect 精确居中绘制的文本。
 * 不用 NSTextField：label 的垂直对齐不可控（默认顶部对齐）、字重固定。
 * 字号/字重在此统一调整。
 */
@interface BannerView : NSView
@property(copy) NSString* text;
@end

@implementation BannerView

- (void)drawRect:(NSRect)dirtyRect {
    (void)dirtyRect;
    if (self.text.length == 0) {
        return;
    }
    NSDictionary* attrs = @{
        NSFontAttributeName: [NSFont systemFontOfSize:14 weight:NSFontWeightSemibold],
        NSForegroundColorAttributeName: [NSColor colorWithCalibratedWhite:0.95 alpha:1.0],
    };
    CGSize size = [self.text sizeWithAttributes:attrs];
    NSPoint origin = NSMakePoint((self.bounds.size.width - size.width) / 2.0,
                                 (self.bounds.size.height - size.height) / 2.0);
    [self.text drawAtPoint:origin withAttributes:attrs];
}

- (void)setText:(NSString*)text {
    _text = [text copy];
    [self setNeedsDisplay:YES];
}

@end

/** C++ 状态的 ObjC 包装：dispatch 块捕获后传给视图（避免块拷贝 C++ 对象的歧义） */
@interface ToolbarStateBox : NSObject
- (instancetype)initWithState:(const ToolbarUiState&)state;
- (const ToolbarUiState&)state;
@end

@implementation ToolbarStateBox {
    ToolbarUiState _state;
}

- (instancetype)initWithState:(const ToolbarUiState&)state {
    if (self = [super init]) {
        _state = state;
    }
    return self;
}

- (const ToolbarUiState&)state {
    return _state;
}

@end

/**
 * 浮窗面板：无边框窗口默认不能成为 key window（AppKit 硬规则），输入框
 * 收键盘必须 override canBecomeKeyWindow。NonactivatingPanel 的 key 化
 * 不会激活宿主应用（PS 焦点不受影响）。
 */
@interface ToolbarPanel : NSPanel
@end

@implementation ToolbarPanel

- (BOOL)canBecomeKeyWindow {
    return YES;
}

- (BOOL)canBecomeMainWindow {
    return NO;
}

@end

/**
 * 三态内容视图：全部子视图一次性创建，applyUiState 切换可见性/取值/禁用态。
 * 按钮态：[✦ 生成式填充][✨ 移去][✕ 关闭]；输入态：[提示词输入框][生成][取消]；
 * 横幅态（banner）：入队成功反馈，整窗横幅淡入 + 轻微上滑（随后 JS 收起浮窗）。
 * 输入框逐键回传 input 事件；Enter（NSTextField action）回传 click:submit。
 */
@interface ToolbarContentView : NSView <NSTextFieldDelegate>
- (void)applyUiState:(ToolbarStateBox*)box;
@end

@implementation ToolbarContentView {
    NSTextField* _status;
    NSButton* _genBtn;
    NSButton* _removeBtn;
    NSButton* _closeBtn;
    NSTextField* _prompt;
    NSButton* _submitBtn;
    NSButton* _cancelBtn;
    BannerView* _banner;
    BOOL _inputMode;
    BOOL _bannerMode;
    BOOL _bannerOut;  // 淡出动画已启动（防重入）
    BOOL _busy;
    NSColor* _statusNormalColor;
    NSColor* _statusErrorColor;
}

- (instancetype)initWithFrame:(NSRect)frame {
    if (self = [super initWithFrame:frame]) {
        self.wantsLayer = YES;
        self.layer.backgroundColor = [NSColor colorWithCalibratedWhite:0.11 alpha:0.97].CGColor;
        self.layer.cornerRadius = 10.0;
        self.layer.borderColor = [NSColor colorWithCalibratedWhite:1.0 alpha:0.15].CGColor;
        self.layer.borderWidth = 1.0;

        _statusNormalColor = [NSColor colorWithCalibratedWhite:0.85 alpha:1.0];
        _statusErrorColor = [NSColor colorWithCalibratedRed:1.0 green:0.42 blue:0.36 alpha:1.0];

        // 左侧拖动把手（通高）
        ToolbarHandleView* handle =
            [[ToolbarHandleView alloc] initWithFrame:NSMakeRect(0, 0, kHandleW, frame.size.height)];
        [self addSubview:handle];

        // 自适应布局：按实际传入宽高计算（hybrid dylib 在 PS 进程内可能常驻，
        // JS 侧改尺寸时旧 dylib 也能正确排布，不依赖编译期常量）
        double w = frame.size.width;
        double h = frame.size.height;
        double rowW = w - kMarginL - kMarginR;
        double rowY = (h - kRowH) / 2.0;  // 垂直居中：上下留白相等

        // 状态行（常驻，空文本时隐藏；贴底悬浮不影响主行居中）
        _status = [NSTextField labelWithString:@""];
        _status.font = [NSFont systemFontOfSize:10];
        _status.textColor = _statusNormalColor;
        _status.lineBreakMode = NSLineBreakByTruncatingTail;
        _status.frame = NSMakeRect(kMarginL, kStatusY, rowW, kStatusH);
        _status.hidden = YES;
        [self addSubview:_status];

        // 按钮态三按钮（均分宽度）
        double btnW = (rowW - 2 * kGap) / 3.0;
        _genBtn = [NSButton buttonWithTitle:@"✦ 生成式填充" target:self action:@selector(onGen:)];
        _genBtn.bezelStyle = NSBezelStyleRounded;
        _genBtn.frame = NSMakeRect(kMarginL, rowY, btnW, kRowH);
        [self addSubview:_genBtn];

        _removeBtn = [NSButton buttonWithTitle:@"✨ 移去" target:self action:@selector(onRemove:)];
        _removeBtn.bezelStyle = NSBezelStyleRounded;
        _removeBtn.frame = NSMakeRect(kMarginL + btnW + kGap, rowY, btnW, kRowH);
        [self addSubview:_removeBtn];

        _closeBtn = [NSButton buttonWithTitle:@"✕ 关闭" target:self action:@selector(onClose:)];
        _closeBtn.bezelStyle = NSBezelStyleRounded;
        _closeBtn.frame = NSMakeRect(kMarginL + 2 * (btnW + kGap), rowY, btnW, kRowH);
        [self addSubview:_closeBtn];

        // 输入态：输入框 + 生成 + 取消
        double inputW = rowW - 90 - 76 - 2 * kGap;
        _prompt = [[NSTextField alloc] initWithFrame:NSMakeRect(kMarginL, rowY, inputW, kRowH)];
        _prompt.font = [NSFont systemFontOfSize:12];
        _prompt.placeholderString = @"描述要生成的内容…";
        _prompt.delegate = self;
        _prompt.target = self;
        _prompt.action = @selector(onSubmit:);  // Enter 触发（单行 NSTextField action）
        _prompt.bezelStyle = NSTextFieldRoundedBezel;
        [self addSubview:_prompt];

        _submitBtn = [NSButton buttonWithTitle:@"生成" target:self action:@selector(onSubmit:)];
        _submitBtn.bezelStyle = NSBezelStyleRounded;
        _submitBtn.frame = NSMakeRect(kMarginL + inputW + kGap, rowY, 90, kRowH);
        [self addSubview:_submitBtn];

        _cancelBtn = [NSButton buttonWithTitle:@"取消" target:self action:@selector(onCancel:)];
        _cancelBtn.bezelStyle = NSBezelStyleRounded;
        _cancelBtn.frame = NSMakeRect(kMarginL + inputW + 90 + 2 * kGap, rowY, 76, kRowH);
        [self addSubview:_cancelBtn];

        // 横幅态：入队成功反馈。铺满整窗的自绘层（文本 drawRect 居中），
        // 默认隐藏；显示时带 Core Animation 淡入 + 上滑（animateBannerIn）。
        _banner = [[BannerView alloc] initWithFrame:NSMakeRect(0, 0, w, h)];
        _banner.wantsLayer = YES;
        _banner.layer.backgroundColor = [NSColor colorWithCalibratedWhite:1.0 alpha:0.07].CGColor;
        _banner.layer.cornerRadius = 10.0;
        _banner.hidden = YES;
        [self addSubview:_banner];

        _inputMode = NO;
        _bannerMode = NO;
        _busy = NO;
        [self syncModeVisibility];
    }
    return self;
}

- (void)syncModeVisibility {
    BOOL banner = _bannerMode;
    BOOL input = _inputMode;
    _genBtn.hidden = input || banner;
    _removeBtn.hidden = input || banner;
    _closeBtn.hidden = input || banner;
    _prompt.hidden = !input;
    _submitBtn.hidden = !input;
    _cancelBtn.hidden = !input;
    // 横幅态独占整窗：状态行一并隐藏（文本由横幅承载）
    _status.hidden = banner || (_status.stringValue.length == 0);
    _banner.hidden = !banner;
}

/**
 * 横幅淡入 + 从上往下滑入（0.3s ease-out）。
 * 用 Core Animation 显式动画而非 NSAnimationContext/animator：PS 主 runloop
 * 长期运行在自定义模式，animator 的动画计时器（default mode）拿不到时间片，
 * 实测直接跳到终态；CA 动画提交后由 WindowServer 合成，与 runloop 模式无关。
 * 位移用 transform（相对量）而非 position：position 动画依赖布局完成时机，
 * 布局未完成时 model 值不对，实测会从右上角滑入。
 */
- (void)animateBannerIn {
    CALayer* layer = _banner.layer;
    layer.opacity = 1.0;  // model 终态（复位上次淡出后的 0 值）
    CAMediaTimingFunction* ease =
        [CAMediaTimingFunction functionWithName:kCAMediaTimingFunctionEaseOut];
    CABasicAnimation* fade = [CABasicAnimation animationWithKeyPath:@"opacity"];
    fade.fromValue = @(0.0);
    fade.duration = 0.3;
    fade.timingFunction = ease;
    [layer addAnimation:fade forKey:@"bannerFade"];
    // CA y 轴向上：translation y+10 视觉偏上 → 到 identity 即从上滑下
    CABasicAnimation* drop = [CABasicAnimation animationWithKeyPath:@"transform"];
    drop.fromValue = [NSValue valueWithCATransform3D:CATransform3DMakeTranslation(0, 10, 0)];
    drop.toValue = [NSValue valueWithCATransform3D:CATransform3DIdentity];
    drop.duration = 0.3;
    drop.timingFunction = ease;
    [layer addAnimation:drop forKey:@"bannerDrop"];
}

/** 整窗淡出（1.5s ease-in）：动画结束收起浮窗（JS 已停轮询/清缓存）。
 *  作用于 contentView 的 layer（横幅/按钮/背景/边框整个子树一起淡出），
 *  而非 banner 自身层——横幅背景只有 0.07 白，单独淡出视觉上仅文字在变。 */
- (void)animateBannerOut {
    CALayer* layer = self.layer;
    [CATransaction begin];
    [CATransaction setCompletionBlock:^{
        if (gPanel != nil) {
            [gPanel orderOut:nil];
        }
        layer.opacity = 1.0;  // 收起后复位，下次显示不受影响
    }];
    CABasicAnimation* fade = [CABasicAnimation animationWithKeyPath:@"opacity"];
    fade.fromValue = @(1.0);
    fade.toValue = @(0.0);
    fade.duration = 1.5;
    fade.timingFunction =
        [CAMediaTimingFunction functionWithName:kCAMediaTimingFunctionEaseIn];
    [layer addAnimation:fade forKey:@"windowFadeOut"];
    layer.opacity = 0.0;  // model 终态：淡出后保持透明
    [CATransaction commit];
}

- (void)syncBusyEnabled {
    _genBtn.enabled = !_busy;
    _removeBtn.enabled = !_busy;
    _submitBtn.enabled = !_busy;
    // 关闭 / 取消始终可用：用户任何时候都能退出
}

- (void)applyUiState:(ToolbarStateBox*)box {
    const ToolbarUiState& st = box.state;
    if (st.hasMode) {
        BOOL newInput = st.inputMode ? YES : NO;
        BOOL newBanner = st.bannerMode ? YES : NO;
        if (_inputMode != newInput || _bannerMode != newBanner) {
            BOOL showBanner = newBanner && !_bannerMode;
            _inputMode = newInput;
            _bannerMode = newBanner;
            if (!newBanner) {
                // 离开横幅态：复位淡出标记与透明度（下次进入重新播放；
                // completionBlock 可能因窗口提前 orderOut 不跑，这里兜底）
                _bannerOut = NO;
                _banner.layer.opacity = 1.0;
                self.layer.opacity = 1.0;
            }
            [self syncModeVisibility];
            if (newInput && self.window != nil) {
                // 非激活面板收键盘：显式成为 key 窗口（NonactivatingPanel 可以
                // 不激活宿主应用成为 key——浮动面板标准做法），并把焦点交给
                // 输入框。不做这一步输入框收不到任何键盘输入。
                [self.window makeKeyWindow];
                [self.window makeFirstResponder:_prompt];
                [_prompt selectText:nil];
            }
            if (showBanner) {
                if (st.hasStatus) {
                    _banner.text = [NSString stringWithUTF8String:st.status.c_str()];
                }
                [self animateBannerIn];
            }
        }
    }
    if (st.hasBusy && _busy != (st.busy ? YES : NO)) {
        _busy = st.busy ? YES : NO;
        [self syncBusyEnabled];
    }
    if (st.hasValue) {
        _prompt.stringValue = [NSString stringWithUTF8String:st.value.c_str()];
    }
    if (st.hasPlaceholder) {
        _prompt.placeholderString = [NSString stringWithUTF8String:st.placeholder.c_str()];
    }
    if (st.hasStatus) {
        NSString* text = [NSString stringWithUTF8String:st.status.c_str()];
        _status.stringValue = text;
        _status.textColor = st.statusError ? _statusErrorColor : _statusNormalColor;
        _status.hidden = (_bannerMode || st.status.empty()) ? YES : NO;
        if (_bannerMode) {
            // 横幅文本由 status 承载（成功提示走整窗横幅而非状态行）
            _banner.text = text;
        }
    }
    if (st.hasFadeOut && st.fadeOut && _bannerMode && !_bannerOut) {
        _bannerOut = YES;
        [self animateBannerOut];
    }
}

// ---- 事件（主线程）→ relay 线程 → schedule 回 JS ------------------------

- (void)onGen:(id)sender {
    (void)sender;
    PushEventFromMainThread("{\"type\":\"click\",\"id\":\"gen\"}");
}

- (void)onRemove:(id)sender {
    (void)sender;
    PushEventFromMainThread("{\"type\":\"click\",\"id\":\"remove\"}");
}

- (void)onClose:(id)sender {
    (void)sender;
    PushEventFromMainThread("{\"type\":\"click\",\"id\":\"close\"}");
}

- (void)onSubmit:(id)sender {
    (void)sender;
    // 按钮与 Enter 共用：草稿由 input 事件实时同步到 JS，这里只报 id
    PushEventFromMainThread("{\"type\":\"click\",\"id\":\"submit\"}");
}

- (void)onCancel:(id)sender {
    (void)sender;
    PushEventFromMainThread("{\"type\":\"click\",\"id\":\"cancel\"}");
}

- (void)controlTextDidChange:(NSNotification*)obj {
    NSTextField* field = obj.object;
    NSString* text = field.stringValue ?: @"";
    std::string json = "{\"type\":\"input\",\"value\":\"" +
                       JsonEscape(text.UTF8String ? text.UTF8String : "") + "\"}";
    PushEventFromMainThread(std::move(json));
}

@end

namespace {

// ---------------------------------------------------------------- 宿主可见性跟随

/**
 * 浮窗是 floating level 的无边框面板，不随宿主窗口最小化/应用隐藏而消失
 * （PS 文档窗口收进 Dock 后浮窗仍悬在桌面上）。监听宿主窗口 miniaturize
 * 与应用 hide 通知，跟随收起；恢复时重新显示。
 * gHostSuppressed 区分「宿主导致隐藏」与「JS 主动 hideToolbar」：后者不
 * 会被 restore 拉起。
 */
BOOL gHostSuppressed = NO;

void HostVisibilityChangedToHidden() {
    if (gPanel != nil && gPanel.visible) {
        gHostSuppressed = YES;
        [gPanel orderOut:nil];
        std::fprintf(stderr, "[SiliconedBridge] toolbar: hidden by host\n");
    }
}

void HostVisibilityChangedToVisible() {
    if (!gHostSuppressed) {
        return;
    }
    // 多文档场景：还有文档窗口（非 panel）处于最小化状态则继续等
    for (NSWindow* w in NSApplication.sharedApplication.windows) {
        if (w != gPanel && w.isMiniaturized && ![w isKindOfClass:[NSPanel class]]) {
            return;
        }
    }
    gHostSuppressed = NO;
    if (gPanel != nil) {
        [gPanel orderFrontRegardless];
        std::fprintf(stderr, "[SiliconedBridge] toolbar: restored after host visible\n");
    }
}

/** 注册一次性通知观察者（AppKit 窗口/应用通知均在主线程发布，直接操作窗口） */
void InstallHostVisibilityObservers() {
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        NSNotificationCenter* nc = NSNotificationCenter.defaultCenter;
        [nc addObserverForName:NSWindowWillMiniaturizeNotification
                        object:nil
                         queue:nil
                    usingBlock:^(NSNotification* note) {
                        if ((NSWindow*)note.object == gPanel) return;
                        HostVisibilityChangedToHidden();
                    }];
        [nc addObserverForName:NSApplicationWillHideNotification
                        object:nil
                         queue:nil
                    usingBlock:^(NSNotification* note) {
                        HostVisibilityChangedToHidden();
                    }];
        [nc addObserverForName:NSWindowDidDeminiaturizeNotification
                        object:nil
                         queue:nil
                    usingBlock:^(NSNotification* note) {
                        HostVisibilityChangedToVisible();
                    }];
        [nc addObserverForName:NSApplicationDidUnhideNotification
                        object:nil
                         queue:nil
                    usingBlock:^(NSNotification* note) {
                        HostVisibilityChangedToVisible();
                    }];
    });
}

// ---------------------------------------------------------------- 窗口管理（主线程）

/** 在目标位置创建/显示浮窗（必须在主线程调用；@try 兜底防异常打崩宿主）。
 *  hasAnchor：JS 传入选区锚点（全局屏幕坐标，top-left 原点，点）——选区
 *  锚定定位；否则退回固定位置（右缘贴屏幕中线、底缘从下往上 1/4 屏）。 */
void CreateAndShowPanelOnUiThread(double width, double height,
                                  bool hasAnchor, double anchorX, double anchorY) {
    @try {
        InstallHostVisibilityObservers();
        std::fprintf(stderr, "[SiliconedBridge] toolbar: create panel %.0fx%.0f (main=%d)\n",
                     width, height, [NSThread isMainThread] ? 1 : 0);
        NSRect targetRect;
        if (hasAnchor) {
            // JS 传来 UXP「全局显示空间」坐标（top-left 原点、macOS 为点；与
            // viewInfo.globalBounds 同空间）。转 Cocoa（bottom-left 原点）：
            // x 不变；y 关于主屏高度翻转（主屏 frame.origin.y == 0）。
            double primaryH = NSScreen.screens.firstObject.frame.size.height;
            double cocoaTopLeftY = primaryH - anchorY;  // 窗口顶缘
            targetRect = NSMakeRect(anchorX, cocoaTopLeftY - height, width, height);
            std::fprintf(stderr,
                         "[SiliconedBridge] toolbar: anchor global(%.0f,%.0f) -> cocoa origin(%.0f,%.0f)\n",
                         anchorX, anchorY, targetRect.origin.x, targetRect.origin.y);
            // 保险钳制：无论 JS 传什么，浮窗完整落在所在屏的可见区域内
            // （JS 侧已按可见画布钳制，这里兜底防异常输入把浮窗推出屏幕）
            NSScreen* targetScreen = NSScreen.mainScreen;
            for (NSScreen* s in NSScreen.screens) {
                if (NSIntersectsRect(s.frame, targetRect)) {
                    targetScreen = s;
                    break;
                }
            }
            NSRect vf = targetScreen.visibleFrame;
            double minX = vf.origin.x;
            double minY = vf.origin.y;
            double maxX = vf.origin.x + vf.size.width - width;
            double maxY = vf.origin.y + vf.size.height - height;
            targetRect.origin.x = std::min(std::max(targetRect.origin.x, minX), std::max(minX, maxX));
            targetRect.origin.y = std::min(std::max(targetRect.origin.y, minY), std::max(minY, maxY));
        } else {
            NSScreen* screen = NSScreen.screens.firstObject;
            NSRect screenFrame = screen.frame;
            // 目标（AX 语义，top-left 原点）：x = midX - w，yTop = 0.75*screenH - h。
            // 转 Cocoa（bottom-left 原点）：origin.y = screenH - yTop - h = 0.25*screenH。
            double x = screenFrame.origin.x + screenFrame.size.width / 2.0 - width;
            double y = screenFrame.origin.y + screenFrame.size.height * 0.25;
            targetRect = NSMakeRect(x, y, width, height);
        }

        if (gPanel == nil) {
            ToolbarPanel* panel = [[ToolbarPanel alloc]
                initWithContentRect:targetRect
                            styleMask:NSWindowStyleMaskBorderless | NSWindowStyleMaskNonactivatingPanel
                              backing:NSBackingStoreBuffered
                                defer:NO];
            panel.level = NSFloatingWindowLevel;
            panel.releasedWhenClosed = NO;
            panel.opaque = NO;
            panel.backgroundColor = [NSColor clearColor];
            panel.hasShadow = YES;
            // 加固：PS 失焦时浮窗不自动隐藏；点击不试图成为 key 窗口
            panel.hidesOnDeactivate = NO;
            panel.becomesKeyOnlyIfNeeded = YES;
            panel.contentView = [[ToolbarContentView alloc] initWithFrame:NSMakeRect(0, 0, width, height)];
            gPanel = panel;
            std::fprintf(stderr, "[SiliconedBridge] toolbar: panel created\n");
        } else {
            NSRect oldFrame = [gPanel frame];
            bool sizeChanged = oldFrame.size.width != width || oldFrame.size.height != height;
            if (hasAnchor) {
                // 每次浮现重新锚定选区（浮窗随选区移动；sizeChanged 时内容视图
                // 一并重建，setFrame 同时更新尺寸）
                if (sizeChanged) {
                    gPanel.contentView =
                        [[ToolbarContentView alloc] initWithFrame:NSMakeRect(0, 0, width, height)];
                }
                [gPanel setFrame:targetRect display:YES];
            } else if (sizeChanged) {
                // 复用面板但尺寸变化（JS 布局升级 / dylib 常驻跨插件重载）：
                // 调整窗口大小并重建内容视图；位置保持左上角不动（不破坏用户
                // 拖动的位置）
                double topLeftY = oldFrame.origin.y + oldFrame.size.height;
                [gPanel setFrame:NSMakeRect(oldFrame.origin.x, topLeftY - height, width, height)
                         display:YES];
                gPanel.contentView =
                    [[ToolbarContentView alloc] initWithFrame:NSMakeRect(0, 0, width, height)];
                std::fprintf(stderr, "[SiliconedBridge] toolbar: panel resized to %.0fx%.0f\n",
                             width, height);
            }
        }
        // nonactivating 面板用 orderFrontRegardless：显示但不夺走 PS 焦点
        [gPanel orderFrontRegardless];
        std::fprintf(stderr, "[SiliconedBridge] toolbar: panel shown\n");
    } @catch (NSException* e) {
        std::fprintf(stderr, "[SiliconedBridge] toolbar create/show exception: %s\n",
                     e.reason.UTF8String ?: "unknown");
        PushEventFromMainThread(std::string("{\"type\":\"error\",\"message\":\"create/show exception\"}"));
    }
}

/** 在 PS 主线程执行块；块内自带 @try，异常只记日志 + 推 error 事件 */
void DispatchToMainThread(void (^block)(void)) {
    dispatch_async(dispatch_get_main_queue(), ^{
        @try {
            block();
        } @catch (NSException* e) {
            std::fprintf(stderr, "[SiliconedBridge] toolbar main-thread exception: %s\n",
                         e.reason.UTF8String ?: "unknown");
            PushEventFromMainThread(std::string("{\"type\":\"error\",\"message\":\"main-thread exception\"}"));
        }
    });
}

// ---------------------------------------------------------------- 状态解析（JS 线程）

bool HasProp(addon_env env, addon_value obj, const char* name) {
    addon_value v = nullptr;
    return UxpAddonApis.uxp_addon_get_named_property(env, obj, name, &v) == addon_ok && v != nullptr;
}

std::string GetString(addon_env env, addon_value v) {
    size_t len = 0;
    if (UxpAddonApis.uxp_addon_get_value_string_utf8(env, v, nullptr, 0, &len) != addon_ok) {
        return std::string();
    }
    std::vector<char> buf(len + 1);
    if (UxpAddonApis.uxp_addon_get_value_string_utf8(env, v, buf.data(), buf.size(), &len) != addon_ok) {
        return std::string();
    }
    return std::string(buf.data(), len);
}

ToolbarUiState ParseToolbarState(addon_env env, addon_value obj) {
    ToolbarUiState st;
    if (obj == nullptr) {
        return st;
    }
    addon_value v = nullptr;

    if (HasProp(env, obj, "mode")) {
        UxpAddonApis.uxp_addon_get_named_property(env, obj, "mode", &v);
        std::string mode = GetString(env, v);
        st.inputMode = (mode == "input");
        st.bannerMode = (mode == "banner");
        st.hasMode = true;
    }
    if (HasProp(env, obj, "status")) {
        UxpAddonApis.uxp_addon_get_named_property(env, obj, "status", &v);
        st.status = GetString(env, v);
        st.hasStatus = true;
    }
    if (HasProp(env, obj, "statusError")) {
        UxpAddonApis.uxp_addon_get_named_property(env, obj, "statusError", &v);
        bool b = false;
        if (UxpAddonApis.uxp_addon_get_value_bool(env, v, &b) == addon_ok) {
            st.statusError = b;
            st.hasStatus = true;  // 推 statusError 一般伴随 status 文本
        }
    }
    if (HasProp(env, obj, "busy")) {
        UxpAddonApis.uxp_addon_get_named_property(env, obj, "busy", &v);
        bool b = false;
        if (UxpAddonApis.uxp_addon_get_value_bool(env, v, &b) == addon_ok) {
            st.busy = b;
            st.hasBusy = true;
        }
    }
    if (HasProp(env, obj, "fadeOut")) {
        UxpAddonApis.uxp_addon_get_named_property(env, obj, "fadeOut", &v);
        bool b = false;
        if (UxpAddonApis.uxp_addon_get_value_bool(env, v, &b) == addon_ok) {
            st.fadeOut = b;
            st.hasFadeOut = true;
        }
    }
    if (HasProp(env, obj, "placeholder")) {
        UxpAddonApis.uxp_addon_get_named_property(env, obj, "placeholder", &v);
        st.placeholder = GetString(env, v);
        st.hasPlaceholder = true;
    }
    if (HasProp(env, obj, "value")) {
        UxpAddonApis.uxp_addon_get_named_property(env, obj, "value", &v);
        st.value = GetString(env, v);
        st.hasValue = true;
    }
    return st;
}

}  // namespace

// ---------------------------------------------------------------- JS 导出实现

addon_value ShowToolbarImpl(addon_env env, addon_callback_info info) {
    try {
        addon_value arg = nullptr;
        size_t argc = 1;
        UxpAddonApis.uxp_addon_get_cb_info(env, info, &argc, &arg, nullptr, nullptr);

        double width = kWidth;
        double height = kHeight;
        bool hasAnchor = false;
        double anchorX = 0;
        double anchorY = 0;
        if (argc >= 1 && arg != nullptr) {
            addon_value v = nullptr;
            if (UxpAddonApis.uxp_addon_get_named_property(env, arg, "width", &v) == addon_ok &&
                v != nullptr) {
                UxpAddonApis.uxp_addon_get_value_double(env, v, &width);
            }
            if (UxpAddonApis.uxp_addon_get_named_property(env, arg, "height", &v) == addon_ok &&
                v != nullptr) {
                UxpAddonApis.uxp_addon_get_value_double(env, v, &height);
            }
            // 选区锚点（全局屏幕坐标，top-left 原点）：x/y 同时有效才启用
            addon_value vx = nullptr;
            addon_value vy = nullptr;
            if (UxpAddonApis.uxp_addon_get_named_property(env, arg, "x", &vx) == addon_ok &&
                vx != nullptr &&
                UxpAddonApis.uxp_addon_get_named_property(env, arg, "y", &vy) == addon_ok &&
                vy != nullptr) {
                double x = 0;
                double y = 0;
                if (UxpAddonApis.uxp_addon_get_value_double(env, vx, &x) == addon_ok &&
                    UxpAddonApis.uxp_addon_get_value_double(env, vy, &y) == addon_ok &&
                    std::isfinite(x) && std::isfinite(y)) {
                    hasAnchor = true;
                    anchorX = x;
                    anchorY = y;
                }
            }
        }

        // 窗口操作全部投递到 PS 主线程（见文件头线程模型）；立即返回，
        // 创建失败通过 error 事件回传（JS 侧 waitToolbarEvent 可见）。
        DispatchToMainThread(^{
            CreateAndShowPanelOnUiThread(width, height, hasAnchor, anchorX, anchorY);
        });

        addon_value undefinedVal = nullptr;
        UxpAddonApis.uxp_addon_get_undefined(env, &undefinedVal);
        return undefinedVal;
    } catch (...) {
        UxpAddonApis.uxp_addon_throw_error(env, nullptr, "showToolbar: internal error");
        return nullptr;
    }
}

addon_value HideToolbarImpl(addon_env env, addon_callback_info /*info*/) {
    try {
        DispatchToMainThread(^{
            if (gPanel != nil) {
                [gPanel orderOut:nil];
                std::fprintf(stderr, "[SiliconedBridge] toolbar: panel hidden\n");
            }
        });

        addon_value undefinedVal = nullptr;
        UxpAddonApis.uxp_addon_get_undefined(env, &undefinedVal);
        return undefinedVal;
    } catch (...) {
        UxpAddonApis.uxp_addon_throw_error(env, nullptr, "hideToolbar: internal error");
        return nullptr;
    }
}

addon_value SetToolbarStateImpl(addon_env env, addon_callback_info info) {
    try {
        addon_value arg = nullptr;
        size_t argc = 1;
        UxpAddonApis.uxp_addon_get_cb_info(env, info, &argc, &arg, nullptr, nullptr);
        if (argc < 1 || arg == nullptr) {
            UxpAddonApis.uxp_addon_throw_error(env, nullptr, "setToolbarState: missing state argument");
            return nullptr;
        }

        ToolbarUiState st = ParseToolbarState(env, arg);
        DispatchToMainThread([st]() {
            if (gPanel == nil || gPanel.contentView == nil ||
                ![gPanel.contentView isKindOfClass:[ToolbarContentView class]]) {
                return;
            }
            ToolbarContentView* view = static_cast<ToolbarContentView*>(gPanel.contentView);
            [view applyUiState:[[ToolbarStateBox alloc] initWithState:st]];
        });

        addon_value undefinedVal = nullptr;
        UxpAddonApis.uxp_addon_get_undefined(env, &undefinedVal);
        return undefinedVal;
    } catch (...) {
        UxpAddonApis.uxp_addon_throw_error(env, nullptr, "setToolbarState: internal error");
        return nullptr;
    }
}

addon_value WaitToolbarEventImpl(addon_env env, addon_callback_info /*info*/) {
    try {
        addon_deferred deferred = nullptr;
        addon_value promise = nullptr;
        if (UxpAddonApis.uxp_addon_create_promise(env, &deferred, &promise) != addon_ok) {
            UxpAddonApis.uxp_addon_throw_error(env, nullptr, "waitToolbarEvent: create promise failed");
            return nullptr;
        }

        std::string json;
        bool immediate = false;
        {
            std::lock_guard<std::mutex> lock(gMutex);
            if (!gEvents.empty()) {
                json = gEvents.front();
                gEvents.pop_front();
                immediate = true;
            } else {
                // 挂起：后续事件由 relay 线程 schedule 回 JS 线程 resolve
                gPendingEnv = env;
                gPendingDeferred = deferred;
            }
        }

        if (immediate) {
            // 与挂起路径统一：一律经 schedule 异步 resolve（同步 resolve 发生
            // 在本次 addon 调用栈内，非 runCommand 已验证模式，规避风险）
            EventTask* task = new EventTask{env, deferred, std::move(json)};
            UxpAddonApis.uxp_addon_schedule_on_javascript_queue(env, ResolveEventTask, task,
                                                                [](addon_task_data d) {
                                                                    delete static_cast<EventTask*>(d);
                                                                });
        }
        return promise;
    } catch (...) {
        UxpAddonApis.uxp_addon_throw_error(env, nullptr, "waitToolbarEvent: internal error");
        return nullptr;
    }
}
