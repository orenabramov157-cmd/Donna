import type { AppEnv } from '../env';
import type { Channel } from './types';
import { loopMessage } from './loopmessage';
import { twilio } from './twilio';

export function getChannel(env: AppEnv): Channel {
  return env.CHANNEL === 'twilio' ? twilio : loopMessage;
}

export type { Channel, Inbound, SendOpts } from './types';
