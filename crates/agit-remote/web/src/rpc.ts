// JSON-RPC over the console WebSocket, reconnecting with backoff. Replies are correlated by
// id; everything else is a notification (`peer.state`, `peer.frame`, `console.lagged`).
import type { Frame, RpcFailure } from "./types";

export type ConnectionState = "connecting" | "open" | "closed";

export class RpcError extends Error {
  code: number;
  data?: RpcFailure["data"];
  constructor(failure: RpcFailure) {
    super(failure.message);
    this.code = failure.code;
    this.data = failure.data;
  }
  /** The request certainly did not reach the executor, so repeating it is safe. */
  get notSent(): boolean {
    return this.data?.outcome === "not_sent";
  }
}

type Pending = { resolve: (frame: Frame) => void; reject: (error: Error) => void };

export class Rpc {
  private socket: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private waiting: Array<() => void> = [];
  private delay = 500;
  private stopped = true;
  private everOpened = false;
  onFrame: (frame: Frame) => void = () => {};
  onState: (state: ConnectionState, everOpened: boolean) => void = () => {};

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.open();
  }

  stop(): void {
    this.stopped = true;
    this.socket?.close();
  }

  /** Forces a fresh socket, for example after the server reports a lagged event cursor. */
  restart(): void {
    this.socket?.close();
  }

  private open(): void {
    const socket = new WebSocket(`${location.origin.replace(/^http/, "ws")}/console/ws`);
    this.socket = socket;
    this.onState("connecting", this.everOpened);
    socket.onopen = () => {
      this.delay = 500;
      this.everOpened = true;
      this.onState("open", true);
      this.waiting.splice(0).forEach((resume) => resume());
    };
    socket.onmessage = (message) => {
      let frame: Frame;
      try {
        frame = JSON.parse(message.data);
      } catch {
        return;
      }
      const pending = typeof frame.id === "number" ? this.pending.get(frame.id) : undefined;
      if (pending && frame.method === undefined) {
        this.pending.delete(frame.id as number);
        pending.resolve(frame);
      } else {
        this.onFrame(frame);
      }
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      for (const pending of this.pending.values()) {
        pending.reject(new RpcError({ code: 300, message: "connection lost", data: { outcome: "unknown" } }));
      }
      this.pending.clear();
      this.onState("closed", this.everOpened);
      if (!this.stopped) {
        setTimeout(() => this.open(), this.delay);
        this.delay = Math.min(this.delay * 2, 10_000);
      }
    };
  }

  private ready(): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new RpcError({ code: 300, message: "not connected", data: { outcome: "not_sent" } })), 20_000);
      this.waiting.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /** Sends a request and returns the reply frame; JSON-RPC errors become `RpcError`. */
  async call<T = any>(method: string, params: unknown = {}): Promise<T> {
    await this.ready();
    const id = this.nextId++;
    const frame = await new Promise<Frame>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket!.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
    if (frame.error) throw new RpcError(frame.error);
    return frame.result as T;
  }
}
