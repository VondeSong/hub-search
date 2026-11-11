import {expect,it} from "vitest";
import {normalizeMobileAppearance} from "./MobileAppearance";
it("accepts supported appearance choices and safely defaults malformed profile values",()=>{
 expect(normalizeMobileAppearance('{"theme":"paper","accent":"sage"}')).toEqual({theme:"paper",accent:"sage"});
 for(const raw of [null,"bad","null",'{"theme":"unknown","accent":"constructor"}'])expect(normalizeMobileAppearance(raw)).toEqual({theme:"system",accent:"blue"});
});
