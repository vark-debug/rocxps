import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { isDocumentOpen, matchDocument, normalizePath, type DocCandidate } from "./docMatch";

const doc = (
  id: number,
  name: string,
  path: string,
  width = 1000,
  height = 800,
): DocCandidate => ({ id, name, path, width, height });

describe("normalizePath", () => {
  it("去掉 file:// 前缀与尾部斜杠", () => {
    assert.equal(normalizePath("file:///Users/a/b.psd"), "/Users/a/b.psd");
    assert.equal(normalizePath("/Users/a/b.psd/"), "/Users/a/b.psd");
  });

  it("macOS 的 /private 前缀归一", () => {
    assert.equal(normalizePath("/private/var/folders/a.psd"), "/var/folders/a.psd");
    assert.equal(
      normalizePath("/private/var/folders/a.psd"),
      normalizePath("/var/folders/a.psd"),
    );
  });

  it("不做小写化、不解码", () => {
    assert.equal(normalizePath("/Users/A/B.psd"), "/Users/A/B.psd");
    assert.equal(normalizePath("/Users/A%20B/C.psd"), "/Users/A%20B/C.psd");
  });

  it("空值与空白返回空串", () => {
    assert.equal(normalizePath(""), "");
    assert.equal(normalizePath("   "), "");
    assert.equal(normalizePath(null), "");
  });
});

describe("matchDocument", () => {
  it("按 id 命中优先", () => {
    const docs = [doc(1, "A.psd", "/a.psd"), doc(2, "B.psd", "/b.psd")];
    const m = matchDocument(docs, { docId: 2, docName: "A.psd", docPath: "/a.psd" });
    assert.equal(m.docId, 2);
    assert.equal(m.kind, "id");
  });

  it("id 失效后按路径 + 尺寸唯一命中（关闭重开）", () => {
    const docs = [
      doc(7, "A.psd", "/private/var/a.psd"),
      doc(8, "A.psd", "/var/other.psd"),
    ];
    const m = matchDocument(docs, {
      docId: 5,
      docName: "A.psd",
      docPath: "/var/a.psd",
      canvasWidth: 1000,
      canvasHeight: 800,
    });
    assert.equal(m.docId, 7);
    assert.equal(m.kind, "path");
  });

  it("路径相同但尺寸不同不命中", () => {
    const docs = [doc(7, "A.psd", "/var/a.psd", 1200, 900)];
    const m = matchDocument(docs, {
      docId: 5,
      docName: "A.psd",
      docPath: "/var/a.psd",
      canvasWidth: 1000,
      canvasHeight: 800,
    });
    assert.equal(m.docId, undefined);
  });

  it("多个同路径同尺寸候选：拒绝自动匹配", () => {
    const docs = [doc(7, "A.psd", "/var/a.psd"), doc(9, "A.psd", "/var/a.psd")];
    const m = matchDocument(docs, {
      docId: 5,
      docName: "A.psd",
      docPath: "/var/a.psd",
      canvasWidth: 1000,
      canvasHeight: 800,
    });
    assert.equal(m.docId, undefined);
    assert.equal(m.candidates.length, 2);
  });

  it("path 为空（未保存文档）退化为名称 + 尺寸唯一命中", () => {
    const docs = [
      doc(7, "未命名-1", ""),
      doc(8, "未命名-2", ""),
    ];
    const m = matchDocument(docs, {
      docId: 5,
      docName: "未命名-2",
      docPath: "",
      canvasWidth: 1000,
      canvasHeight: 800,
    });
    assert.equal(m.docId, 8);
    assert.equal(m.kind, "name");
  });

  it("云文档 path 不是绝对路径：不参与路径匹配，退化到名称", () => {
    const docs = [doc(7, "Cloud.psd", "adobe-cloud-id"), doc(8, "Other.psd", "/var/x.psd")];
    const m = matchDocument(docs, {
      docId: 5,
      docName: "Cloud.psd",
      docPath: "adobe-cloud-id",
      canvasWidth: 1000,
      canvasHeight: 800,
    });
    assert.equal(m.docId, 7);
    assert.equal(m.kind, "name");
  });

  it("全部不命中：不返回目标", () => {
    const docs = [doc(7, "A.psd", "/var/a.psd")];
    const m = matchDocument(docs, {
      docId: 5,
      docName: "B.psd",
      docPath: "/var/b.psd",
      canvasWidth: 1000,
      canvasHeight: 800,
    });
    assert.equal(m.docId, undefined);
    assert.deepEqual(m.candidates, []);
  });

  it("捕获缺少尺寸时只按唯一路径匹配", () => {
    const docs = [doc(7, "A.psd", "/var/a.psd")];
    const m = matchDocument(docs, { docId: 5, docName: "A.psd", docPath: "/var/a.psd" });
    assert.equal(m.docId, 7);
    assert.equal(m.kind, "path");
  });
});

describe("isDocumentOpen", () => {
  it("目标 id 仍在打开列表 → true", () => {
    assert.equal(isDocumentOpen(7, [3, 7, 9]), true);
  });

  it("目标文档已关闭（列表里没有该 id）→ false", () => {
    assert.equal(isDocumentOpen(7, [3, 9]), false);
    assert.equal(isDocumentOpen(7, []), false);
  });
});
