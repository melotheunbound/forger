import { Collection } from 'discordeno';
import EventListener from 'libs/listener';
import type { CollectorData, CollectorEvents, CollectorOptions } from 'types/types';

const collectors = new Collection<string, CollectorData<any>>();
const MAX_INTERACTION_LIFETIME = 14 * 60 * 1000;

export default function createCollector<T>(options: CollectorOptions<T>) {
  const id = `${options.key}_${Date.now()}`;
  const collected: T[] = [];
  let stopped = false;
  let timeout: NodeJS.Timeout | undefined;
  let absoluteTimeout: NodeJS.Timeout | undefined;

  const listener = new EventListener() as any as EventListener<CollectorEvents<T>> & {
    collect(item: T): Promise<void>;
    dispose(reason?: string): void;
  };

  if (options.duration) {
    timeout = setTimeout(() => listener.dispose('time'), options.duration);
    if (options.duration > MAX_INTERACTION_LIFETIME) {
      absoluteTimeout = setTimeout(() => listener.dispose('interaction-token-expired'), MAX_INTERACTION_LIFETIME);
    }
  }

  listener.collect = async (item: T) => {
    if (stopped) return;

    const pass = options.filter ? await options.filter(item) : true;
    if (!pass) return;

    collected.push(item);
    listener.emit('collect', item);

    if (options.duration) {
      if (timeout) clearTimeout(timeout);
      timeout = setTimeout(() => listener.dispose('time'), options.duration);
    }

    if (options.max && collected.length >= options.max) listener.dispose('max');
  };

  listener.dispose = (reason: string = 'unknown') => {
    if (stopped) return;
    stopped = true;

    if (timeout) clearTimeout(timeout);
    if (absoluteTimeout) clearTimeout(absoluteTimeout);

    listener.emit('dispose', reason);
    listener.removeAllListeners();

    collectors.delete(id);
  };

  collectors.set(id, {
    id,
    key: options.key,
    max: options.max,
    filter: options.filter,
    listener,
  });

  return listener;
}
