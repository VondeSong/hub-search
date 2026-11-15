export function calendarPeriodKey(year:number,month:number){
 if(!Number.isInteger(year)||year<100||year>9999||!Number.isInteger(month)||month<1||month>12)return null;
 return `${String(year).padStart(4,"0")}-${String(month).padStart(2,"0")}`;
}
export function calendarDateKey(date:Date){
 return `${String(date.getFullYear()).padStart(4,"0")}-${String(date.getMonth()+1).padStart(2,"0")}-${String(date.getDate()).padStart(2,"0")}`;
}
