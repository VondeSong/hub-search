"""Query-only candidate strategies. No gold labels, IDs, or document lookup."""
import re

import jieba.posseg

# Generic question/function words, not topic-specific synonyms or answer keys.
STOP = set('现在 是否 已经 什么 什么时候 怎么 怎样 如何 哪些 哪个 哪里 哪 两个 几个 多少 需要 可以 应该 能够 直接 自动 全部 整个 这次 这个 那个 一条 一件 同一 为了 还有 仍然 一起 起来 进行 处理 提供 出来 出现 部分 工作 内容 使用'.split())


def keywords(text):
    result = []
    for token in jieba.posseg.cut(text):
        word = token.word.strip()
        if word in STOP or not re.search(r'[\w\u4e00-\u9fff]', word):
            continue
        if not (token.flag.startswith(('n', 'v', 'a', 'eng', 'm')) or word.isascii()):
            continue
        if len(word) < 2 and not word.isdigit():
            continue
        if word.lower() not in {item.lower() for item in result}:
            result.append(word)
    return result[:8]


def render(text, operator):
    return (' ' + operator + ' ').join('"' + word.replace('"', ' ') + '"' for word in keywords(text))
