/**
 * The super admin's switch for using the platform's subscriptions through ClikCode (the Gateway's
 * `subscriptions` lane). On by default. Sent with every Gateway request as
 * `X-ClikCode-Subscriptions`; the Gateway honours it for the super admin only, and tells only the
 * super admin its state (the model list's `clikcode.subscriptions`), which is what shows the switch.
 * It changes nothing the platform's own agents use.
 */
import type Conf from 'conf';

const KEY = 'gatewaySubscriptions';

export function gatewaySubscriptionsOn(config: Conf): boolean {
  return config.get(KEY) !== false;
}

export function setGatewaySubscriptions(config: Conf, on: boolean): void {
  config.set(KEY, on);
}

export function subscriptionsHeader(on: boolean): Record<string, string> {
  return { 'x-clikcode-subscriptions': on ? 'on' : 'off' };
}
