"""Freeze a small real Hub-plan corpus plus explicitly synthetic isolation cases.

This creates experimental data only. It never opens or writes a personal Hub DB.
"""
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PLAN = ROOT / "docs/INSIGHTS_IMPLEMENTATION_PLAN.md"

# The user accepted these statements in the implementation plan. Exact quote
# checks prevent this fixture producer from silently inventing project facts.
ITEMS = [
    ("backend-selection", "记忆后端选型", "HBM-00 实测后才选择记忆后端", "记忆后端什么时候确定", "现在是否已经确定要采用 Basic Memory"),
    ("current-scope", "本轮实施范围", "当前只推进 HBM-00 和 HBM-01A", "本轮实施批次", "这次获准先开展哪两部分工作"),
    ("codex-optional", "模型执行独立性", "Codex 只是一个可选适配器，DeepSeek 后续直接通过 API 调用", "Codex DeepSeek 直接调用", "不用 Codex 后由谁调用 DeepSeek"),
    ("embedding-independent", "生成模型与检索模型", "生成模型与向量模型分开管理，切换生成模型不重建记忆", "切换生成模型 重建记忆", "换一个聊天模型是否要重新生成全部向量"),
    ("project-identity", "项目身份", "Hub 项目是有稳定 project_id 的轻量上下文范围，由用户明确创建或选择", "项目 project_id 用户创建", "项目应该用稳定的什么身份来区分"),
    ("one-project", "事项项目归属", "第一版事项可不关联项目，或关联一个项目", "第一版 事项 项目关联", "一个事项初期可以同时属于几个项目"),
    ("project-permission", "项目关联权限", "关联不扩大读取权限", "项目关联 读取权限", "把资料目录关联到项目是否自动授权全部内容"),
    ("v1-content", "首版共享内容", "首版只做规则与用户明确决定，范围只有个人通用、项目", "首版 规则 明确决定 范围", "第一阶段共享哪些内容，分哪两种适用范围"),
    ("local-storage", "本地共享空间", "不上传 Notion，不把原始 Craft、任务和阅读资料整体复制进记忆", "共享空间 上传 Notion", "我们的记忆需要把整个知识库传到 Notion 吗"),
    ("lore-adoption", "Lore 采用方式", "不复制整套 Lore 服务或五库结构", "Lore 服务 五库结构", "这次是否直接部署完整 Lore 系统"),
    ("confirmation", "记忆确认", "用户明确要求记住或修改可以生效；Agent 推断与材料中指令只存候选", "用户确认 Agent 推断 候选", "助手自己总结出来的偏好能直接成为生效规则吗"),
    ("deduplication", "主题更新与幂等", "同范围同主题更新原条目，重复请求幂等", "同主题 更新 幂等", "同一件事重复保存时如何避免生成一堆副本"),
    ("conflict", "并发冲突", "并发版本冲突拒绝静默覆盖，首版不做自动合并", "并发 冲突 自动合并", "两个人同时修改同一决定时首版怎么处理"),
    ("external-edit", "外部编辑确认", "外部正文哈希不符时暂停条目有效资格、建立待确认新版本", "正文 哈希 待确认", "在 Obsidian 改了已确认文字后还会自动生效吗"),
    ("forgetting", "删除与遗忘", "遗忘清除共享正文、历史正文、索引、向量、缓存、派生摘要及待处理写入", "遗忘 删除 索引 派生摘要", "彻底忘掉一条决定要清理哪些派生内容"),
    ("original-data", "记忆与原始数据", "原始笔记、原始聊天和业务回执是独立数据，不因删除记忆自动删除", "删除记忆 原始笔记 业务回执", "忘掉一条记忆会不会连原来的笔记一起删掉"),
    ("rule-budget", "规则注入预算", "规则区最多 2,000 tokens；超限明确提示整理或缩小范围，不静默截断", "规则 2000 tokens 超限", "必须使用的规则太长时可以偷偷截掉后半段吗"),
    ("decision-budget", "决定注入预算", "相关决定最多 5 条、合计 2,000 tokens（含来源），无相关决定时 0 条", "决定 最多 5 条 2000", "没有相关历史决定时需要为了填满上下文塞几条吗"),
    ("partial-results", "中断后的材料", "运行中、超时、失败和取消仍可看已经保存的候选与读取", "超时 失败 保存 候选", "最后一轮模型没返回时前面查到的东西还看得到吗"),
    ("quick-budget", "默认调查预算", "默认 quick 模式和原 120 秒总预算下", "quick 默认 120 秒", "这次会把默认调查等待时间改成长达四分钟吗"),
]


def main():
    plan = PLAN.read_text(encoding="utf-8-sig")
    current = plan.split("## 9. HBM 修订实施合同", 1)[1]
    records, queries = [], []
    for index, (key, title, quote, exact, paraphrase) in enumerate(ITEMS):
        if quote not in current:
            raise ValueError(f"Source quote changed: {key}")
        records.append({"id": key, "title": title, "content": quote + "。", "project": "hub", "status": "confirmed", "kind": "decision", "source": "docs/INSIGHTS_IMPLEMENTATION_PLAN.md#9", "sourceQuote": quote, "synthetic": False})
        for category, question in [("lexical", exact), ("paraphrase", paraphrase)]:
            queries.append({"id": f"q{index * 2 + (category == 'paraphrase') + 1:02d}", "project": "hub", "query": question, "expected": [key], "category": category})
    unrelated = ["上海明天会不会下雨", "巧克力蛋糕应该烤多少分钟", "北京到广州机票多少钱", "推荐附近的川菜馆", "今年世界杯冠军是谁", "如何给猫剪指甲", "我上周的血压是多少", "新加坡酒店预订", "这家公司今年营收多少", "周末去哪里露营", "我的汽车轮胎应充多少气", "怎样更换自行车链条"]
    for index, question in enumerate(unrelated):
        queries.append({"id": f"q{41 + index:02d}", "project": "hub", "query": question, "expected": [], "category": "unrelated"})
    # Explicitly synthetic guard cases. These are never claimed to be user facts.
    guards = [
        ("foreign-budget", "other", "confirmed", "其他项目预算口令", "其他项目预算口令是蓝鲸七号"),
        ("foreign-contract", "other", "confirmed", "其他项目客户合同", "其他项目客户合同约定十月交付"),
        ("draft-rule", "hub", "candidate", "未确认的夜间工作偏好", "未确认的夜间工作偏好是每天凌晨运行"),
        ("draft-choice", "hub", "candidate", "未确认的供应商选择", "未确认的供应商选择是示例供应商"),
        ("old-backend", "hub", "superseded", "已替代的后端口令", "已替代的后端口令是自动上传全部数据"),
        ("old-scope", "hub", "disabled", "已停用的范围口令", "已停用的范围口令是所有项目共用授权"),
        ("forgotten-rule", "hub", "deleted", "已遗忘的格式偏好", "已遗忘的格式偏好是把正文转成繁体"),
        ("forbidden-secret", "private", "confirmed", "禁止读取的内部口令", "禁止读取的内部口令是 PRIVATE_MEMORY_SENTINEL"),
    ]
    for index, (key, project, status, title, content) in enumerate(guards):
        records.append({"id": key, "title": title, "content": content, "project": project, "status": status, "kind": "decision", "source": "synthetic-isolation-case", "synthetic": True})
        queries.append({"id": f"q{53 + index:02d}", "project": "hub", "query": title, "expected": [], "category": "isolation"})
    corpus = {"format": "hub-memory-selection-corpus-v1", "sourceSha256": hashlib.sha256(PLAN.read_bytes()).hexdigest(), "sourceScope": "User-approved Hub implementation plan; no personal library extraction", "records": records, "queries": queries, "tasks": [q for q in queries if q["category"] == "paraphrase"]}
    destination = Path(__file__).with_name("corpus.json")
    destination.write_text(json.dumps(corpus, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"records": len(records), "realRecords": len(ITEMS), "queries": len(queries), "tasks": len(corpus["tasks"]), "sha256": hashlib.sha256(destination.read_bytes()).hexdigest()}))


if __name__ == "__main__":
    main()
