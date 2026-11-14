// @vitest-environment jsdom
import {act} from 'react';
import {createRoot} from 'react-dom/client';
import {expect,it,vi} from 'vitest';
import {normalizeResults} from './SearchResultNormalization';
import {sourceTypeLabel} from './SearchResultPresentation';
import {canOpenResultSource} from './ResultOpening';
import {asPageFavorite} from './PageFavorites';
import {QuickSearchResultList} from './QuickSearchResultList';
import {ResultList} from './ResultList';
import {RecentResultList} from './RecentResultList';
const result=(kind:'reading'|'flashcard')=>normalizeResults([{id:kind+':item:version',entityKey:kind+':item',documentId:'item',spaceId:'@hub:'+kind,provider:'hub',contentType:kind,sourceType:kind,libraryName:kind==='reading'?'阅读':'闪卡',title:'Needle result',snippet:'Needle body',matchTerms:['Needle'],matchField:'body'}])[0];
it('preserves the native module identity through page grouping and opens it without a source application',()=>{
 for(const kind of ['reading','flashcard'] as const){const item=result(kind);expect(item.provider).toBe('hub');expect(asPageFavorite(item)).toBe(item);expect(canOpenResultSource(item,[],'android')).toBe(true);expect(sourceTypeLabel(item)).toBe(kind==='reading'?'阅读':'闪卡');}
 expect(normalizeResults([{id:'forged',spaceId:'@hub:other',provider:'hub',contentType:'document'}])).toEqual([]);
});
it.each(['results','recent'])('withholds source-page actions in the %s list too',async(kind)=>{
 (globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host);const prepare=vi.fn(),item=result('reading');
 const props={selectedIndex:0,isMobileLayout:false,onHoverResult:vi.fn(),onSelectResult:vi.fn(),onOpenResult:vi.fn(),onContextResult:vi.fn(),onPrepareResultLink:prepare,onDragResult:vi.fn(),renderLibraryIcon:()=>null,onToggleFavorite:vi.fn()};
 try{
  await act(async()=>root.render(kind==='results'?<ResultList {...props} query="Needle" results={[item]}/>:<RecentResultList {...props} semanticRecentDates={false} recentGroups={[{key:'today',label:'Today',entries:[{index:0,result:item}]}]}/>));
  expect(host.querySelector('[aria-label="收藏页面"]')).toBeNull();expect(host.querySelector('[draggable="true"]')).toBeNull();
  await act(async()=>host.querySelector('[role="option"]')!.dispatchEvent(new MouseEvent('mouseover',{bubbles:true})));
  expect(prepare).not.toHaveBeenCalled();
 }finally{await act(async()=>root.unmount());host.remove();delete(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT;}
});
it('routes module results to their exact item while withholding unsupported source-page actions',async()=>{
 (globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host);const open=vi.fn(),prepare=vi.fn();const item=result('flashcard');
 try{
  await act(async()=>root.render(<QuickSearchResultList query="Needle" results={[item]} selectedIndex={0} renderLibraryIcon={()=>null} onSelectResult={()=>{}} onOpenResult={open} onPrepareResultLink={prepare} onDragResult={()=>{}} onToggleFavorite={()=>{}} onToggleSnippetFavorite={()=>{}}/>));
  expect(host.querySelector('[aria-label="收藏页面"]')).toBeNull();expect(host.querySelector('[draggable="true"]')).toBeNull();
  const button=[...host.querySelectorAll('button')].find(b=>b.textContent?.includes('Needle result'))!;expect(button).toBeTruthy();
  await act(async()=>{button.dispatchEvent(new MouseEvent('mouseover',{bubbles:true}));button.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));});
  expect(prepare).not.toHaveBeenCalled();expect(open).toHaveBeenCalledWith(expect.objectContaining({provider:'hub',contentType:'flashcard',documentId:'item'}));
 }finally{await act(async()=>root.unmount());host.remove();delete(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT;}
});
