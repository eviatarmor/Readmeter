import { AsyncLocalStorage } from "node:async_hooks";

const resetLinks = new Map<string, string>();

export function stashResetLink(email: string, url: string) {
  resetLinks.set(email.toLowerCase(), url);
}

export function takeResetLink(email: string): string | undefined {
  const key = email.toLowerCase();
  const url = resetLinks.get(key);
  if (url) resetLinks.delete(key);
  return url;
}

export const inviteLinkStore = new AsyncLocalStorage<{ link?: string }>();

export function noteInviteLink(link: string) {
  const box = inviteLinkStore.getStore();
  if (box) box.link = link;
}
