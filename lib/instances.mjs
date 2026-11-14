// Maps the `instance` tool argument to a panel instance. Only configured aliases are reachable,
// plus (in wildcard mode) the instances discovered on the allowed nodes.
import { McsmError } from './panel.mjs';

const DISCOVERY_PAGE_SIZE = 50;
const MAX_DISCOVERY_PAGES = 20;
// A lookup miss re-runs discovery (the instance may be new), but not more often than this.
const REDISCOVER_AFTER_MS = 5000;

/**
 * @param {object} config validated config.json
 * @param {{ request: Function }} panel
 */
export function createInstances(config, panel) {
  const aliases = Object.keys(config.instances);
  const { enabled: wildcard, allowed_daemons: allowedDaemons } = config.wildcard;
  let discovered = []; // [{ uuid, daemonId, nickname, node, status }]
  let discoveredAt = 0;

  /** Lists the instances on every available, allowed node. Needs an admin key. */
  async function discover() {
    const daemons = await panel.request('GET', '/api/service/remote_services_list');
    const found = [];
    for (const daemon of daemons) {
      if (!daemon.available) continue;
      if (allowedDaemons.length > 0 && !allowedDaemons.includes(daemon.uuid)) continue;
      let pageCount = 1;
      for (let page = 1; page <= pageCount && page <= MAX_DISCOVERY_PAGES; page++) {
        const result = await panel.request('GET', '/api/service/remote_service_instances', {
          query: { daemonId: daemon.uuid, page, page_size: DISCOVERY_PAGE_SIZE },
        });
        pageCount = result.maxPage;
        for (const instance of result.data) {
          found.push({
            uuid: instance.instanceUuid,
            daemonId: daemon.uuid,
            nickname: instance.config.nickname ?? '',
            node: daemon.remarks ?? '',
            status: instance.status,
          });
        }
      }
    }
    discovered = found;
    discoveredAt = Date.now();
    return found;
  }

  async function findDiscovered(nameOrUuid) {
    const find = () =>
      discovered.filter((i) => i.uuid === nameOrUuid || i.nickname.toLowerCase() === nameOrUuid.toLowerCase());
    let matches = find();
    if (matches.length === 0 && Date.now() - discoveredAt > REDISCOVER_AFTER_MS) {
      await discover();
      matches = find();
    }
    if (matches.length > 1) throw new McsmError(`"${nameOrUuid}" 匹配到多个实例，请改用 UUID（可用 discover_instances 查看）`);
    if (matches.length === 0) throw new McsmError(`未找到实例 "${nameOrUuid}"（通配模式下仅限 allowed_daemons 范围内的实例）`);
    const { uuid, daemonId, nickname } = matches[0];
    return { name: `${nickname || 'instance'}(${uuid.slice(0, 8)})`, address: { uuid, daemonId } };
  }

  /**
   * @param {string} [alias] configured alias, or in wildcard mode a nickname or UUID; omitted = the default instance
   * @returns {Promise<{ name: string, address: { uuid: string, daemonId: string } }>} `name` is for audit entries
   */
  async function resolve(alias) {
    const name = alias ?? config.default_instance ?? (aliases.length === 1 ? aliases[0] : undefined);

    // A configured alias always wins over a discovered nickname.
    const configured = name && config.instances[name];
    if (configured) return { name, address: { uuid: configured.uuid, daemonId: configured.daemon_id } };

    if (wildcard) {
      if (!name?.trim()) throw new McsmError('请通过 instance 参数指定实例（别名、昵称或 UUID），可先调用 discover_instances 查看');
      return findDiscovered(name.trim());
    }
    if (!name) throw new McsmError(`请通过 instance 参数指定实例，可选: ${aliases.join(', ')}`);
    throw new McsmError(`未知实例 "${name}"，可选: ${aliases.join(', ')}`);
  }

  return { resolve, discover };
}
