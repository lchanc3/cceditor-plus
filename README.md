# CCEditor+

角色卡編輯器與翻譯工具。讀寫 SillyTavern 相容的 v1 / v2 / v3 角色卡（PNG 與 JSON），
支援 Google Gemini 與任何 OpenAI 相容端點的 AI 翻譯。

純前端、無後端、無內建金鑰 — 卡片只在你的瀏覽器裡處理。

```bash
npm install
npm run dev      # http://localhost:3000
npm test         # 角色卡編解碼測試
npm run build    # 產出 dist/
```

## 功能

- **v1 / v2 / v3 讀寫**，PNG（`chara` + `ccv3` chunk）與 JSON 皆可。同時存在時依規範以 `ccv3` 優先。
- **無損編輯** — 未建模的欄位原樣保留，匯出時寫回去。
- **四種匯出格式**：`v1` / `v2` / `v3` / **`max`**。`max` 同時具備 V1 的扁平欄位與 V3 的 `spec`+`data` 結構，任何版本的讀取器都能正確讀取（對應 CCEditor 的 `toMaxCompatibleSpec`）。
- **AI 翻譯**：Gemini 或任何 OpenAI 相容端點（OpenAI、OpenRouter、DeepSeek、Groq、LM Studio、Ollama、one-api…）。可取消、失敗自動重試。
- **模型清單自動搜尋** — 兩種服務都能打端點列出可用模型，直接點選或自動補完。
- **行動版友善**：可捲動的分頁列、觸控裝置上永遠可見的操作按鈕、44px 觸控目標、safe-area 內距、底部固定操作列。
- **草稿自動保存**到 IndexedDB（含圖片），手機分頁被回收也不會掉資料。

## 隱私

沒有後端，也沒有建置期金鑰。API 金鑰只存在瀏覽器的 localStorage；
只有在你按下翻譯時，該欄位的文字才會送往你自己設定的服務。

## 測試

```bash
npm test
```

涵蓋 PNG chunk 讀寫與 CRC、v1/v2/v3 偵測與正規化、四種序列化輸出、
SillyTavern 匯入相容性斷言，以及最重要的往返測試（read → 編輯 → write → 再 read）。

**想確認你自己的卡片能不能正確存讀**，把它們丟進 `tests/fixtures/local/`
（已列入 .gitignore）再跑 `npm test`。測試會自動掃描該目錄並對每一張做往返驗證。

重新產生內建 fixture：`npm run fixtures`。

## 部署

三個平台共用同一份 build，差別只在 `base` 路徑。

**Vercel** — 匯入 repo 即可，`vercel.json` 已設定好。

**Cloudflare Workers**
```bash
npm run build && npx wrangler deploy
```
（Cloudflare Pages 也適用：build 指令 `npm run build`，輸出目錄 `dist`。）

**GitHub Pages** — 推上 `main` 即由 `.github/workflows/deploy-pages.yml` 自動部署。
Workflow 會把 `VITE_BASE` 設為 `/<repo 名稱>/`；若使用 `<user>.github.io` 這種
使用者站台，請改成 `/`。

## 參考資料

- [lenML/CCEditor](https://github.com/lenML/CCEditor)
- [lenML/char-card-reader](https://github.com/lenML/char-card-reader)
- [lenML/char-card-writer](https://github.com/lenML/char-card-writer)

規格出處：
- [Character Card V2](https://github.com/malfoyslastname/character-card-spec-v2/blob/main/spec_v2.md)
- [Character Card V3](https://github.com/kwaroran/character-card-spec-v3/blob/main/SPEC_V3.md)

## 架構

```
src/
  card/        角色卡編解碼層 — 零 React 相依，可獨立測試
    binary.ts    base64 / UTF-8 / CRC32（不使用 Node Buffer）
    png.ts       PNG chunk 讀寫（tEXt / iTXt / zTXt）
    model.ts     CardModel + 正規化 + 四種序列化
    read.ts      File → CardModel
    write.ts     CardModel → bytes / JSON 字串
  ai/          供應商層 — 原生 fetch，無 SDK
  components/  UI
  state/       卡片 reducer
tests/         Vitest；fixtures/local/ 放你自己的卡
```

## 授權

[AGPL-3.0-only](LICENSE)。

若你修改本專案並將其部署為網路服務，AGPL 第 13 條要求你必須讓使用該服務的人
也能取得你修改後的原始碼 —— 這也是為什麼頁尾有一個永遠可見的原始碼連結。

`reference/` 內的 lenML 倉庫僅作為規範對照，**本專案未引用其任何程式碼**。
