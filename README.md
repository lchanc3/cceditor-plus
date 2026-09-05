# CCEditor+

角色卡編輯器與翻譯工具。讀寫 SillyTavern 相容的 v1 / v2 / v3 角色卡（PNG 與 JSON），
支援 Google Gemini 與任何 OpenAI 相容端點的 AI 翻譯。

純前端、無後端、無內建金鑰 — 卡片只在你的瀏覽器裡處理。

```bash
npm install
npm run dev      # http://localhost:3000
npm test         # 編解碼、術語表與翻譯任務測試
npm run build    # 產出 dist/
```

## 功能

- **v1 / v2 / v3 讀寫**，PNG（`chara` + `ccv3` chunk）與 JSON 皆可。同時存在時依規範以 `ccv3` 優先。
- **無損編輯** — 未建模的欄位原樣保留，匯出時寫回去。
- **四種匯出格式**：`v1` / `v2` / `v3` / **`max`**。`max` 同時具備 V1 的扁平欄位與 V3 的 `spec`+`data` 結構，任何版本的讀取器都能正確讀取（對應 CCEditor 的 `toMaxCompatibleSpec`）。匯出時可選擇是否附帶術語表；V1 只有 6 個欄位、沒有 `extensions`，術語表無法隨之保留，對話框會直說。
- **AI 翻譯**：Gemini 或任何 OpenAI 相容端點（OpenAI、OpenRouter、DeepSeek、Groq、LM Studio、Ollama、one-api…）。可取消、失敗自動重試。
- **模型清單自動搜尋** — 兩種服務都能打端點列出可用模型，直接點選或自動補完。
- **翻譯術語表**：先讓 AI 從卡片抽出專有名詞，再逐一議定譯名，之後每次翻譯都只把該段文字用得到的詞釘進提示詞裡——200 個詞的卡片也不會撐出一個巨大的 prompt。譯名可鎖定、可標記「保留原文」、可設別名；你手填的與匯入的譯名，後續 AI 只會補空白，永遠不會覆寫。術語表連同風格註記存在卡片的 `data.extensions.cceditor_plus` 裡，跟著卡片走，也能單獨匯入／匯出 JSON。
- **整卡翻譯**：一次翻完所有欄位、開場白與世界書條目，最多三段並行，可中途取消。局部成功是刻意的——被內容過濾器擋下的那一段不會拖垮其餘十九段，失敗的段落保留原文，重試時只花在那幾段上。
- **翻譯報告**：每段是成功、被擋、還是被限流一目了然，並附上四種確定性檢查：`{{char}}` / `{{user}}` 巨集數量對不上、換行結構被改動、繁體中文譯文裡混進簡體字、模型自己寫進正文的譯註。只報告，不自動修——為了滿足啟發式規則去改寫完成的譯文，正是譯文出現破碎句子的原因。
- **請求節流**：可設每分鐘請求數（預設 10），整趟翻譯共用同一個節流閘。免費 Gemini 方案是按分鐘計額度的，長卡片翻到一半就會被掐；先把請求排開，比等 429 回來才反應有用——額度那時已經花掉了。
- **行動版友善**：可捲動的分頁列、觸控裝置上永遠可見的操作按鈕、44px 觸控目標、safe-area 內距、底部固定操作列。
- **草稿自動保存**到 IndexedDB（含圖片），手機分頁被回收也不會掉資料。

## 隱私

沒有後端，也沒有建置期金鑰。API 金鑰只存在瀏覽器的 localStorage；
只有在你按下翻譯時，該欄位的文字才會送往你自己設定的服務。

術語表是唯一會離開瀏覽器又留在檔案裡的東西：它存在卡片內，所以把卡片分享出去，
等於把你議定的譯名與風格註記一起分享。不想帶的話，匯出對話框可以關掉它。

## 測試

```bash
npm test
```

涵蓋 PNG chunk 讀寫與 CRC、v1/v2/v3 偵測與正規化、四種序列化輸出、
SillyTavern 匯入相容性斷言，以及最重要的往返測試（read → 編輯 → write → 再 read）。
翻譯側則涵蓋術語表的存取、合併與譯名優先序、譯文檢查的四種判定、
供應商回應的容錯 JSON 解析，以及整卡翻譯的重試、限流與局部失敗處理。

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
    json.ts      容錯解析：端點說好的 JSON 常常不是 JSON
    tasks.ts     翻譯任務 — 術語表兩段式、整卡翻譯、重試、節流閘
  glossary/    術語表 — 同樣零 React 相依
    storage.ts   存在卡片的哪裡、怎麼編解碼
    model.ts     區段路徑、播種、掃描出現位置、合併兩份術語表
    checks.ts    對完成的譯文做確定性檢查
  components/  UI
  hooks/       useTranslate — 翻譯任務的狀態與進度
  lib/         下載、草稿（IndexedDB）、className 工具
  state/       卡片 reducer
tests/         Vitest；fixtures/local/ 放你自己的卡
```

## 授權

[AGPL-3.0-only](LICENSE)。

若你修改本專案並將其部署為網路服務，AGPL 第 13 條要求你必須讓使用該服務的人
也能取得你修改後的原始碼。