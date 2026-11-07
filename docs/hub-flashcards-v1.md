# Hub 闪卡数据协议 v1

`hub-flashcards-v1` 用于让 Codex 或其他 Agent 把闪卡候选提交到 Hub 收件箱。导入内容首先是本机草稿；用户接受后才进入牌组和 WebDAV 同步。

## 推荐目录

```text
hub-flashcards-v1/
├── manifest.json
└── cards.jsonl
```

`manifest.json`：

```json
{
  "format": "hub-flashcards-v1",
  "version": 1,
  "deckName": "AI API",
  "cardsFile": "cards.jsonl",
  "generator": {
    "agent": "codex",
    "workflow": "deep-flashcards-v1"
  }
}
```

`cards.jsonl` 每行一个 JSON 对象：

```json
{"question":"RPM 在 AI API 调用中表示什么？","answer":"Requests Per Minute，即每分钟请求数。","explanation":"它描述 API 的请求频率限制。","cardType":"qa","tags":["AI","API"],"confidence":0.96,"evidence":"RPM 表示每分钟发起了多少次 API 调用请求。","source":{"sourceLibraryId":"library-id","sourceDocumentId":"document-id","sourceBlockId":"block-id","sourceTitle":"AI API 限流","sourcePath":"使用AI","sourceHash":"sha256-or-source-hash"},"idempotencyKey":"ai-api-rpm-v1"}
```

也可以导入单个 JSON 文件，把 `cards` 数组直接放入清单：

```json
{
  "format": "hub-flashcards-v1",
  "version": 1,
  "deckName": "AI API",
  "cards": [
    {
      "question": "TPM 表示什么？",
      "answer": "Tokens Per Minute，即每分钟 Token 数。",
      "cardType": "qa"
    }
  ]
}
```

## 校验规则

- 一次最多 5000 张，数据文件最大 16 MB，文本使用 UTF-8。
- `question` 至少 3 个字符、最多 1000 个字符；`answer` 必填、最多 4000 个字符。
- `cardType` 只能为 `qa` 或 `cloze`。
- `confidence` 如提供，必须在 0 到 1 之间。
- Hub 使用 `idempotencyKey` 以及问题/答案组合去重；未提供键时会生成稳定哈希。
- `source`、`tags`、`evidence`、`generation` 和 `media` 均为可选字段。
- `cardsFile` 只能指向 `manifest.json` 所在目录内的文件。

媒体 v1 接受 `https://`、`http://`、`data:` 或 `hub-media://` URL。包含本地媒体文件的完整数据包将在后续版本加入。

