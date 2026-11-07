# 制卡 MCP 附件

## 导入

`hub_import_flashcard_attachment` 接收以下两种输入之一：

```json
{"filePath":"D:\\Notes\\示意图.png","placement":"question"}
```

```json
{"fileName":"说明.pdf","dataBase64":"文件原始字节的 Base64","placement":"explanation"}
```

路径是 **Hub MCP 所在电脑**上的绝对文件路径。只导入用户指定或授权的文件。Base64 不带 `data:` 前缀。单文件最多 64 MB。

返回的 `media` 对象原样放入 `hub_submit_flashcard_drafts` 的 `cards[].media`，每卡最多 8 个；位置为 `question`、`answer` 或 `explanation`，默认 `answer`。返回的 `mediaId` 可交给 `hub_read_media` 查看。

## 显示与保存

- 图片显示，音频和视频提供播放控件；播放格式取决于系统 WebView 的编解码支持。
- PDF、Office、文本等提供系统应用打开和另存为；其他文件可另存。
- 附件按内容哈希存入本地 Blob 仓库，不依赖原文件继续存在。草稿归入牌组后，附件沿用闪卡媒体同步流程。
- `hub_read_media` 最多读取 12 MB：图片返回 image，MP3/WAV 返回 audio，文本返回文本资源，其余格式返回二进制资源。客户端是否能解读 PDF/Office 等资源取决于客户端能力；上传文件不等于已经提取或理解其中内容。
- MCP 外部客户端提交的 HTTP 图片或附件地址仍是外链。需要离线保存时，先将文件下载到本机，再导入。
- 附件提交仍进入收件箱，由用户移入牌组。

更换 Hub 程序后需重连 MCP 客户端，以刷新新增工具。
