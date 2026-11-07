"""Post-run correlation only; never modifies policy, labels or primary scoring."""
import json
from connection_support import WORK,save,read
from connection_phases import correlate

if __name__=='__main__':
    dev=read('development-audit.json')
    process=json.loads((WORK/'development-server/process.json').read_text(encoding='utf-8'))
    slow_id=read('development-contract.json')['slowPriorIds'][0]
    focused=[]
    for row in dev['results']:
        if row['id']==slow_id:
            focused.append({'round':row['round'],'mode':row['mode'],'callMs':row['callMs'],
                'remoteEvents':row['remoteEvents'],
                **correlate(WORK/row['directory'],process,row['receipt'],WORK/'shared-codex-state/logs_2.sqlite',row['startUnixNs'],row['endUnixNs'])})
    formal=read('evaluation.json')['results']
    process=json.loads((WORK/'validation-server/process.json').read_text(encoding='utf-8'))
    slow=[]
    for number,row in sorted(enumerate(formal,1),key=lambda t:-t[1]['endToEndMs'])[:3]:
        slow.append({'number':number,'id':row['id'],'endToEndMs':row['endToEndMs'],
                    **correlate(WORK/f'validation-{number:03}',process,row['modelReceipt'],WORK/'shared-codex-state/logs_2.sqlite')})
    save('tail-followup.json',{'prior26sQuestionPaired':focused,'newFrozenSetSlowest':slow,
        'causalLimit':'Same disclosed old question is repeated with identical prompt, but cache and upstream load are uncontrolled. A shorter repeat does not establish root-cause removal.',
        'serverSubphasesResolved':False})
    print(json.dumps({'oldQuestionRepeats':[{'round':r['round'],'mode':r['mode'],'ms':r['callMs']} for r in focused],
                      'newSlowest':[{'number':r['number'],'ms':r['endToEndMs'],'requestWaitMs':r['formalMarkerToFirstNativeItemMs']} for r in slow]}))
