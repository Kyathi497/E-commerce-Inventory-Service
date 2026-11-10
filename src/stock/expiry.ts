import { Injectable, type OnApplicationBootstrap, type OnApplicationShutdown } from "@nestjs/common";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { ReservationsService } from "./reservations.service.js";

// Releases holds whose 15-minute payment window passed (§6.4) and announces
// reservation.expired. Runs in every replica; see expireDue for why that's safe.
@Injectable()
export class ExpirySweeper implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<unknown> = Promise.resolve();

  constructor(private readonly reservations: ReservationsService) {}

  onApplicationBootstrap() {
    this.timer = setInterval(() => {
      this.running = this.reservations.expireDue().catch((err) => logger.error({ err }, "expiry sweep failed"));
    }, config.EXPIRY_SWEEP_SECONDS * 1000);
    this.timer.unref();
  }

  async onApplicationShutdown() {
    clearInterval(this.timer);
    await this.running;
  }
}
