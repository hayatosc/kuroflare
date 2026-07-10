# クライアント: エディタとファイルシステム

[← 設計書トップ](../../spec.md)

## 1. CM6 バインディング

Obsidian は内部で CodeMirror 6 を管理しており、`y-codemirror.next` を挿すには `registerEditorExtension` + `Compartment.reconfigure` で active editor ごとに binding を差し替える。

```js
const yCompartment = new Compartment()
registerEditorExtension([yCompartment.of([])]) // 登録時は空

// file-open / active-leaf-change で:
const view = leaf.view.editor.cm // 半公式アクセス（更新で壊れうる）
view.dispatch({
  effects: yCompartment.reconfigure(
    yCollab(ytext, awareness, { undoManager: false }), // Obsidian undo を優先
  ),
})
```

- awareness は optional injection。provider 未実装の間は `null` に縮退し、実装後に同じ binding surface へ接続する（`hello.capabilities` と一致させる）。
- 同じファイル、同じ EditorView への冗長な再バインドはスキップする。layout-ready と foreground-resume の連続発火で yCollab 拡張を作り直すと編集内容を壊しうる。

**file-open 時の真実の所在**：YText が真実である。

- YText がこのクライアントで空（初見）→ ディスク内容で seed。
- 空でない → YText が勝つ。ディスクと hash 比較し、違えば materialize する。
- y-indexeddb の `whenSynced` 前に seed しない。timeout で妥協すると、再起動後に復元前の YDoc を古い disk 内容で上書きしうる。

**active file への materialize 禁止**：binding 中のファイルは YText → EditorView が唯一の反映経路である。
materializer が同じ path に `Vault.modify` すると、Obsidian の内部バッファ、watcher、YText が三つ巴になる。
active leaf の fileId は materialize queue から除外し、閉じた時または inactive 化した時だけ disk flush する。

active file がリモートで rename された場合は binding を維持して path だけ安全なタイミングで更新する（fileId は同じ）。
delete された場合は tombstone が立つが、未保存 / 未同期 edit があれば delete vs edit（[sync-model.md](sync-model.md) §5）として復活させる。

## 2. ハッシュゲートと materialize CAS

エコーループ（observe → disk 書き込み → watcher 発火 → また Yjs へ）を止める中核の機構。
書き込みの記録として `lastMaterialized[fileId] = { ydocHash, diskHash, path, writtenAt, writeId }` を IndexedDB に保持する。

なお YText → disk の書き込み自体は 1〜2 秒アイドルまたは file close 時に debounce する。
これは正しさの機構ではなく write amplification 対策で、ループはハッシュゲートと CAS だけで止まる。

watcher 発火時:

1. 現在の diskHash を計算する。
2. `diskHash == lastMaterialized.diskHash` → 自分の書き込みなので no-op。
3. `diskHash == currentYTextHash` → 収束済みなので no-op。
4. それ以外 → 外部編集として YText に transaction で取り込む。

materialize 実行時:

1. 対象が active editor に binding 中なら disk write しない（§1）。
2. 書く直前に diskHash を再計算する。
3. `diskHash == lastMaterialized.diskHash` の時だけ `Vault.modify`。
4. 違う場合は未観測の外部編集なので上書き禁止（block-conflict）。disk 内容を conflict copy へ退避し、YText へ外部編集として取り込み、改めて収束結果を materialize queue へ積む（retry 規則は [client.md](client.md) §5）。
5. 成功後に `lastMaterialized` を更新する。

この compare-and-swap が最後の防衛線である。
watcher event が欠落しても coalesce されても順序が入れ替わっても、未観測の disk 変更を上書きで消さない。

**active editor 判定の強制**：materialize decision は `activeEditorBound: boolean` を直接受け取らず、`path` と `activeFilePath`（未 bound なら `undefined`）を受け取って内部で一致判定する。
呼び出し側は判定結果でなく生の bind 状態を渡す義務を負うため、どの呼び出し口でも固定値の混入が起きない。
bind 状態は副作用実行の直前（async 処理の後）で再評価してから渡し、切り替わりの競合を判定の鮮度で吸収する。
`lastMaterialized` が無い時は安全な base hash がないため write を拒否する。

**canonical text hash**：hash gate と CAS は raw text ではなく canonical hash（SHA-256）を使う。
先頭 BOM を除去、CRLF / CR を LF に正規化、non-empty text は terminal newline 1 つとして比較する。
YText 本文は BOM なし LF を canonical form とする（terminal newline の正規化は hash 比較専用で本文には強制しない）。
これで EOL 差や末尾改行差による外部編集の誤検出と conflict copy の量産を避ける。

**最小置換での取り込み**：外部編集は全文 delete+insert にせず、共通 prefix / suffix を除いた中央だけを `Y.Text.delete/insert` する。
全文置換は op が肥大化するうえ、並行 edit と合流した時に「全消し」と中間 insert が絡んで意図と違う形に収束しやすい。

**非アクティブファイルの外部編集検出**：`modify` watcher は active file に限定せず全ファイルを対象にする。
ただし hash 計算は高コストなので、`TFile.stat` の mtime / size を `lastMaterialized` の記録と比較する pre-filter を通し、両方一致ならスキップする。
不一致または記録なし（初回観測）の場合だけハッシュゲートへ進む。
binding 中のファイルは pre-filter を経由せず、CM6 経路のみでゲートに入る。

実装: `core/src/local-store/materialize.ts` の `decideWatcherHashGate`（ignore-own-write / ignore-converged-write / import-external-edit）と `decideMaterializeWrite`（skip-active-editor / write / block-conflict）。

## 3. Obsidian Vault API の使い方

- 外部変更を拾う必要がある読み込みは `cachedRead` ではなく `read` を使う。
- 書き込みは `Vault.modify` / `create` / `rename` / `delete` 経由に寄せる。filesystem adapter を直接触るのは chunk cache など Vault 外 / 隠し領域だけ。
- `vault.on('create')` は起動時に大量発火しうるので、layout ready 前のイベントは初回 scan として扱い、通常 watcher と分ける。
- active editor の `EditorView` 取得は公開 API で足りない可能性があるため、そこだけ adapter に閉じ込める。
