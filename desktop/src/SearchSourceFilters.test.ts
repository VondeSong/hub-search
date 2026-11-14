import {expect,it} from 'vitest';
import {normalizeSourceFilters} from './SearchSourceFilters';
it('adds module types to the old all-types choice while preserving a restricted legacy choice',()=>{
 expect(normalizeSourceFilters({}).reading).toBe(true);
 const pdf={craft:false,task:false,pdf:true,media:false,attachment:false};
 expect(normalizeSourceFilters(pdf)).toEqual({...pdf,reading:false,flashcard:false});
 expect(normalizeSourceFilters({...pdf,reading:true})).toEqual({...pdf,reading:true,flashcard:false});
});
it('preserves an explicit no-types choice and the legacy image setting',()=>{
 expect(Object.values(normalizeSourceFilters({craft:false,task:false,pdf:false,image:false,attachment:false}))).toEqual(Array(7).fill(false));
});
