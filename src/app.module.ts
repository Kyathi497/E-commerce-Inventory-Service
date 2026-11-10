import { Module } from "@nestjs/common";
import { config, SERVICE_NAME } from "./config.js";
import { CONSUMERS, ROUTES } from "./events.js";
import { AuthGuardModule } from "./lib/auth-guard/index.js";
import { HealthModule } from "./lib/common/index.js";
import { EventsModule, Outbox } from "./lib/events/index.js";
import { logger } from "./logger.js";
import { PrismaModule } from "./prisma/prisma.module.js";
import { PrismaService } from "./prisma/prisma.service.js";
import { ExpirySweeper } from "./stock/expiry.js";
import { orderHandlers, productHandlers } from "./stock/handlers.js";
import { ReservationsService } from "./stock/reservations.service.js";
import { AdminStockController, AvailabilityController, InternalReservationsController } from "./stock/stock.controller.js";
import { StockService } from "./stock/stock.service.js";

@Module({
  imports: [
    PrismaModule,
    AuthGuardModule.forRoot({
      jwksUrl: config.AUTH_JWKS_URL,
      service: { name: SERVICE_NAME, secret: config.SERVICE_TOKEN_SECRET },
    }),
    HealthModule.register({
      inject: [PrismaService],
      useFactory: (prisma: PrismaService) => ({ db: () => prisma.$queryRaw`SELECT 1` }),
    }),
    EventsModule.forRootAsync({
      adminPath: "admin/events/inventory",
      receive: true,
      inject: [PrismaService],
      useFactory: (prisma: PrismaService) => {
        const options = {
          db: prisma,
          logger,
          source: SERVICE_NAME,
          consumers: CONSUMERS,
          routes: ROUTES,
          serviceTokenSecret: config.SERVICE_TOKEN_SECRET,
          retryDelaysSeconds: config.EVENT_RETRY_DELAYS.map(Number).filter((n) => n > 0),
        };
        // Order handlers publish stock events through the same outbox.
        return { ...options, handlers: { ...productHandlers(), ...orderHandlers(new Outbox(options)) } };
      },
    }),
  ],
  controllers: [AvailabilityController, InternalReservationsController, AdminStockController],
  providers: [StockService, ReservationsService, ExpirySweeper],
})
export class AppModule {}
