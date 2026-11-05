import { forget, remember } from './opened';
import { embed, onFrameMessage, queueRefresh, queueTry } from './refresh';
import { enableSync } from './sync';

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type == "refresh") {
    queueRefresh(message.listId).then(sendResponse);
    return true;
  }
  if (message.type == "try-refresh") {
    queueTry(message).then(sendResponse);
    return true;
  }
  if (message.type == "opened") {
    remember(message.tabs).then(sendResponse);
    return true;
  }
  if (message.type == "forget-opened") {
    forget(message.tabIds).then(sendResponse);
    return true;
  }
  if (message.type == "sync") {
    enableSync(message.enabled).then(sendResponse);
    return true;
  }
  if (message.type == "embed") {
    embed(message.texts).then(vectors => sendResponse({ vectors }), error => sendResponse({ error: error.message }));
    return true;
  }
  onFrameMessage(message, sendResponse);
});
