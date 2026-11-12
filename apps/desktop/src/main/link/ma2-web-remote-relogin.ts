import { Ma2LoginRefused } from './ma2-live-playback';
import { Ma2Relogin, Ma2ReloginStop, type Ma2ReloginClock, type Ma2ReloginLog, type Ma2ReloginPlan } from './ma2-relogin';
import { Ma2ShowSourceChanged } from './ma2-show-probe';

export { Ma2ReloginStop, ma2ReloginReason, type Ma2ReloginClock, type Ma2ReloginLog } from './ma2-relogin';

/** Which web remote session of the console page: the fader view's, or the Button area's (C2). */
export type Ma2ReloginSession = 'fader' | 'buttons';

const LABEL: Record<Ma2ReloginSession, string> = { fader: '推杆区', buttons: 'Button 区' };
const plan = (session: Ma2ReloginSession): Ma2ReloginPlan => ({
  row: 'ma2.webRemote.relogin', line: session,
  words: {
    attempt: (attempt, seconds, minutes, first, reason) => `网页遥控（${LABEL[session]}）断了，第 ${attempt} 次自动重新登录：已经断了 ${seconds} 秒，最多试 ${minutes} 分钟。${first ? '断开的原因' : '上一次没登上'}：${reason}`,
    succeeded: (attempt, seconds) => `网页遥控（${LABEL[session]}）自动重新登录成功：第 ${attempt} 次登上，断了 ${seconds} 秒`,
    limit: (limitText, tried) => `${limitText}（${LABEL[session]}，试了 ${tried} 次）`,
    stopped: reason => `网页遥控（${LABEL[session]}）没有再自动重新登录：${reason}`
  },
  needsPerson: error => error instanceof Ma2ReloginStop || error instanceof Ma2LoginRefused || error instanceof Ma2ShowSourceChanged
});

/**
 * Logging one web remote session in again on its own after it dropped (C2, design 03 §10 question 2): the shared MA2
 * relogin (`ma2-relogin.ts`) with the web remote's row (`ma2.webRemote.relogin`) and words. The console refusing the
 * login and another Show stop it as well as what `Ma2ReloginStop` names.
 */
export class Ma2WebRemoteRelogin<T> extends Ma2Relogin<T> {
  constructor(session: Ma2ReloginSession, login: (target: T) => Promise<void>, log: (entry: Ma2ReloginLog) => void, clock?: Ma2ReloginClock) {
    super(plan(session), login, log, clock);
  }
}
