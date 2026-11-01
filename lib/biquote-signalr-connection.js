import { HubConnectionBuilder, LogLevel } from "@microsoft/signalr";

export const BIQUOTE_TICK_HUB = "https://biquote.io/hubs/tick";

export function createBiquoteConnection({
  url = BIQUOTE_TICK_HUB,
  reconnectDelays = [0, 1000, 3000, 5000, 10000, 15000]
} = {}) {
  if (typeof url !== "string" || !url.startsWith("https://")) {
    throw new Error("SignalR hub URL must use HTTPS.");
  }
  return new HubConnectionBuilder()
    .withUrl(url)
    .withAutomaticReconnect(reconnectDelays)
    .configureLogging(LogLevel.Warning)
    .build();
}
