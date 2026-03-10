import { EventStreaming } from '../core/broker';
import { ConsumerOptions, MessageHandler } from '../interface/interface';

export default class Consumer {
  private eventStreaming: EventStreaming;
  constructor() {
    this.eventStreaming = new EventStreaming();
  }

  public run<T = Record<string, unknown>>(
    opts: ConsumerOptions,
    handler: MessageHandler<T>,
  ) {
    return this.eventStreaming.subscribe(opts, handler);
  }
}
