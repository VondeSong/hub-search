"""Source-aware applicability; exact offset validation at the host boundary."""
from applicability_policy import POLICY as PREVIOUS_POLICY, SCHEMA
from applicability_policy import validate_decisions as previous_validate

POLICY=PREVIOUS_POLICY+'''
来源识别要求：source.recordRole 只表示来源文本有效，不能把读书摘录、作者自述、漫画或小说人物、举例/假设、他人引语、软件说明等自动改成用户本人经历或现实事件。source.leadText、headings 与 text 是同一原文不同位置，必须一起核对称谓、叙述者、文体及限定范围。局部群体的次序不能推出全体最先；叙事、讽刺或比喻中的说法不等于经过核实的现实身份与事件。
text 中明确标记的省略处没有证据；只可从省略标记某一侧选一段连续原文作为 quote。spans 是这些原文的偏移与校验身份，不提供额外事实。支持所问事实所必需的主体、否定、条件或限定在前文时，一并保留在引文里；如果当前片段仍不足以判断归属或所问的属性，abstain。source 字段是出处，不可单凭文件名、标签或状态证明事实。不要因为某候选最相关就选它。
'''

def validate_decisions(response,tasks,memories):
    rows=previous_validate(response,tasks,memories)
    by_mid={m['id']:m for m in memories}
    for row in rows:
        if row['ids']:
            memory=by_mid[row['ids'][0]]
            quote=row['decision']['quote']
            if not any(quote in span for span in memory['text'].split('\n〔非连续原文，省略部分不得补推〕\n')):
                row['ids']=[];row['invalid']='discontinuous_quote'
    return rows
