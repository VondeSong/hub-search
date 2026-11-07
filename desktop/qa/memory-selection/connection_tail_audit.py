"""Read only the exact prior slow runs and their bounded native-log windows."""
import json
import sqlite3

from connection_support import ROOT,PREVIOUS,save,digest

if __name__=='__main__':
    evaluation=json.loads((PREVIOUS/'evaluation.json').read_text(encoding='utf-8'))
    questions={q['id']:q for q in json.loads((PREVIOUS/'validation.json').read_text(encoding='utf-8'))['cases']}
    process=json.loads((ROOT/'.local/hbm-00/latency-20261018/validation-persistent/process.json').read_text(encoding='utf-8'))
    log_path=ROOT/'.local/hbm-00/latency-20261018/shared-codex-state/logs_2.sqlite'
    con=sqlite3.connect(log_path.resolve().as_uri()+'?mode=ro',uri=True)
    rows=[]
    for number,r in sorted(enumerate(evaluation['results'],1),key=lambda t:t[1]['endToEndMs'],reverse=True)[:3]:
        directory=ROOT/f'.local/hbm-00/latency-20261018/validation-{number:03}'
        events=json.loads((directory/'events.json').read_text(encoding='utf-8'))
        receipt=r['modelReceipt']
        end=max(e['ms'] for e in events)
        submit=end-receipt['submitToCompletionMs']
        begin_epoch=process['beganUnixNs']/1e9+submit/1000
        end_epoch=process['beganUnixNs']/1e9+end/1000
        projected=[{'relativeMs':round(e['ms']-submit,3),'method':e['event'].get('method'),
                    'itemType':e['event'].get('params',{}).get('item',{}).get('type'),
                    'deltaChars':len(e['event'].get('params',{}).get('delta',''))}
                   for e in events if e['ms']>=submit]
        # Never export arbitrary log body. Only stable categories and counts in this exact window.
        markers={word:con.execute('SELECT count(*) FROM logs WHERE ts BETWEEN ? AND ? AND (thread_id=? OR thread_id IS NULL) AND instr(lower(coalesce(feedback_log_body,\'\')),?)>0',
                                  (int(begin_epoch)-1,int(end_epoch)+1,receipt['threadId'],word)).fetchone()[0]
                 for word in ['timeout','retry','websocket','stream','error']}
        counts=con.execute('SELECT level,target,count(*) FROM logs WHERE ts BETWEEN ? AND ? AND (thread_id=? OR thread_id IS NULL) GROUP BY level,target',
                           (int(begin_epoch)-1,int(end_epoch)+1,receipt['threadId'])).fetchall()
        rows.append({'number':number,'id':r['id'],'question':questions[r['id']]['query'],
            'inputSha256':receipt['inputSha256'],'e2eMs':r['endToEndMs'],'modelMs':r['modelMs'],
            'threadSetupMs':receipt['threadSetupMs'],'firstAnswerMs':receipt['submitToFirstAnswerDeltaMs'],
            'completeMs':receipt['submitToCompletionMs'],'usage':receipt['usage'],
            'protocol':projected,'nativeLogCategories':counts,'nativeLogMarkerCounts':markers})
    con.close()
    save('prior-tail-audit.json',{'priorEvaluationSha256':digest(PREVIOUS/'evaluation.json'),'rows':rows,
        'interpretation':'The ~26s outlier waits before first visible reasoning/answer despite a short 75-token reasoning output. This does not distinguish network, queue or hidden inference; absent log markers do not prove no retry because log coverage may be limited.'})
    print(json.dumps([{'number':r['number'],'question':r['question'],'firstAnswerMs':r['firstAnswerMs'],
        'nativeLogCategories':r['nativeLogCategories'],'markers':r['nativeLogMarkerCounts']} for r in rows],ensure_ascii=False))
