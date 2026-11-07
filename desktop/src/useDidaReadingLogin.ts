import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { isWindowVisible, subscribeWindowVisibility } from "./WindowVisibility";

export type DidaReadingLoginStatus = {
  connected: boolean; accountMatched: boolean; checkedAt: number; loginWindowOpen: boolean;
  state: "verified" | "authentication" | "account-mismatch" | "unverified" | "service-unavailable";
  message: string;
};
type LoginPhase = "idle" | "opening" | "waiting" | "checking" | "verified" | "failed";
type LoginFeedback = { phase: LoginPhase; status?: DidaReadingLoginStatus; message: string; syncFailure?: boolean };

/** A login window opening is only an acknowledgement, never authentication.
 * Checks are serial and bounded; closing the panel stops further polling. */
export function useDidaReadingLogin(authRequired: boolean, lastCheckedAt: number | undefined, syncError: string, latestAuthFailure: boolean, onOpen: () => void | Promise<void>) {
  const [feedback, setFeedback] = useState<LoginFeedback>({phase:"idle",message:""});
  const [latestSyncFailure,setLatestSyncFailure]=useState("");
  const [requestPending,setRequestPending]=useState(false);
  const active = useRef(true), generation = useRef(0), inFlight = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined), deadline = useRef(0);
  const checkRef = useRef<(manual: boolean, token?: number) => Promise<void>>(async()=>{});
  const automaticPending = useRef(false);
  const stopTimer = useCallback(()=>{if(timer.current!==undefined)clearTimeout(timer.current);timer.current=undefined;},[]);
  useEffect(()=>{active.current=true;return()=>{active.current=false;generation.current++;stopTimer();};},[stopTimer]);
  const scheduleCheck = useCallback((token:number,delay=3000)=>{
    stopTimer();automaticPending.current=true;
    const start=()=>{
      if(!active.current||token!==generation.current){automaticPending.current=false;return;}
      if(!isWindowVisible())return;
      if(inFlight.current){timer.current=setTimeout(start,3000);return;}
      automaticPending.current=false;void checkRef.current(false,token);
    };
    if(isWindowVisible()){if(delay===0)start();else timer.current=setTimeout(start,delay);}
  },[stopTimer]);
  useEffect(()=>{
    let wasVisible=isWindowVisible();
    const changed=()=>{
      const visible=isWindowVisible(),resumed=visible&&!wasVisible;wasVisible=visible;
      if(!visible){if(timer.current!==undefined)automaticPending.current=true;stopTimer();}
      else if(resumed&&automaticPending.current)scheduleCheck(generation.current,0);
    };
    const unsubscribe=subscribeWindowVisibility(changed);changed();return unsubscribe;
  },[scheduleCheck,stopTimer]);

  const check = useCallback(async(manual:boolean, token=generation.current)=>{
    if(!active.current || token!==generation.current || inFlight.current)return;
    if(!manual&&!isWindowVisible()){automaticPending.current=true;return;}
    stopTimer();automaticPending.current=false;inFlight.current=true;setRequestPending(true);
    setFeedback(old=>({...old,phase:"checking",message:deadline.current?"正在验证滴答网页登录与资料库账号…":"正在检查当前滴答网页登录…"}));
    let result:DidaReadingLoginStatus;
    try {
      result=await invoke<DidaReadingLoginStatus>("get_dida_reading_login_status");
      // Unexpected IPC data is a check failure, never a successful login.
      if(!result||typeof result.connected!=="boolean"||typeof result.accountMatched!=="boolean"||typeof result.loginWindowOpen!=="boolean"||!Number.isFinite(result.checkedAt)||typeof result.message!=="string"||!["verified","authentication","account-mismatch","unverified","service-unavailable"].includes(result.state)||(result.connected&&result.state!=="verified"))throw new Error("暂未收到有效的滴答登录检查结果，请重试");
    } catch(error) {
      result={connected:false,accountMatched:false,checkedAt:Math.floor(Date.now()/1000),loginWindowOpen:true,state:"service-unavailable",message:String(error)};
    } finally { inFlight.current=false;if(active.current)setRequestPending(false); }
    if(!active.current||token!==generation.current)return;
    if(result.connected) {
      deadline.current=0;
      setFeedback({phase:"verified",status:result,message:result.message});
      return;
    }
    const awaiting=deadline.current>0;
    const canWait=awaiting&&Date.now()<deadline.current&&result.loginWindowOpen&&["authentication","service-unavailable"].includes(result.state);
    if(canWait) {
      setFeedback({phase:"waiting",status:result,message:result.state==="service-unavailable"?"登录检查暂时无法连接，将稍后重试。也可完成登录后立即检查。":manual?"本次检查尚未通过，请在滴答窗口完成登录；会继续自动检查。":"等待你在滴答窗口完成登录，完成后会自动验证。"});
      scheduleCheck(token);
    } else {
      const timedOut=awaiting&&Date.now()>=deadline.current;
      deadline.current=0;
      setFeedback({phase:"failed",status:result,message:timedOut?`等待登录已结束。${result.message}；完成登录后可立即检查。`:result.message});
    }
  },[stopTimer,scheduleCheck]);
  checkRef.current=check;

  const openLogin=useCallback(async()=>{
    stopTimer();automaticPending.current=false;const token=++generation.current;deadline.current=Date.now()+120000;
    setFeedback({phase:"opening",message:"正在打开滴答登录窗口…"});
    try {
      await onOpen();
      if(!active.current||token!==generation.current)return;
      setFeedback({phase:"waiting",message:"登录窗口已打开。请完成登录，窗口打开不代表验证成功。"});
      // An earlier mount check may still be finishing. The timer prevents an
      // overlapping request while the next serial check waits for it to finish.
      scheduleCheck(token);
    } catch(error) {
      if(!active.current||token!==generation.current)return;
      deadline.current=0;automaticPending.current=false;setFeedback({phase:"failed",message:`无法打开滴答登录窗口：${String(error)}`});
    }
  },[onOpen,stopTimer,scheduleCheck]);

  const previousCheck=useRef(lastCheckedAt||0);
  useEffect(()=>{
    const changed=(lastCheckedAt||0)>previousCheck.current;
    previousCheck.current=lastCheckedAt||0;
    if(authRequired&&latestAuthFailure&&changed) {
      generation.current++;stopTimer();deadline.current=0;automaticPending.current=false;
      setLatestSyncFailure(syncError || "滴答网页登录未通过，原项已保留");
      setFeedback({phase:"failed",syncFailure:true,message:`最近一次同步核验未通过：${syncError || "滴答网页登录未通过，原项已保留"}`});
    } else if(authRequired&&feedback.phase==="idle")void check(false);
    if(!authRequired||(changed&&!latestAuthFailure)) {
      setLatestSyncFailure("");
      setFeedback(old=>old.syncFailure?{phase:"idle",message:""}:old);
    }
  },[authRequired,lastCheckedAt,syncError,latestAuthFailure,feedback.phase,check,stopTimer]);
  const busy=requestPending||feedback.phase==="opening"||feedback.phase==="checking";
  const currentVerified=feedback.phase==="verified"&&!!feedback.status?.connected;
  return {feedback,busy,currentVerified,latestSyncFailure,openLogin,check:()=>void check(true)};
}
