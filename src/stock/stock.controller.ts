import { Body, Controller, Get, Header, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { CurrentUser, InternalOnly, Public, Roles } from "../lib/auth-guard/index.js";
import type { RequestUser } from "../lib/common/index.js";
import {
  AdjustDto,
  AvailabilityDto,
  AvailabilityQuery,
  CreatePackagingDto,
  ListStockQuery,
  MovementsQuery,
  ReceiveDto,
  ReservationsQuery,
  ReserveDto,
  UpdateStockDto,
} from "./dto.js";
import { ReservationsService } from "./reservations.service.js";
import { type Actor, StockService } from "./stock.service.js";

const actor = (user: RequestUser, req: Request): Actor => ({ id: user.id, requestId: req.requestId });
const uuid = new ParseUUIDPipe();

@Public()
@Controller("availability")
export class AvailabilityController {
  constructor(private readonly stock: StockService) {}

  // GET /availability?products=<id>,<id> (up to 100 ids; fine for a few) → same answer as POST.
  @Get()
  @Header("Cache-Control", "no-store")
  getByQuery(@Query() query: AvailabilityQuery) {
    return this.stock.availability(query.products.split(","));
  }

  // POST /availability { products: [<id>, ...] } → { items: { <id>: "in_stock" | "low" | "out" } }
  // A read, but the id list goes in the body so it can't overflow the URL.
  @Post()
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  get(@Body() dto: AvailabilityDto) {
    return this.stock.availability(dto.products);
  }
}

// Order-service holds, commits and releases stock here (§6.4, §6.7).
@InternalOnly()
@Controller("internal/reservations")
export class InternalReservationsController {
  constructor(private readonly reservations: ReservationsService) {}

  @Post()
  reserve(@Body() dto: ReserveDto, @Req() req: Request) {
    return this.reservations.reserve(dto, req.requestId);
  }

  @Get(":orderId")
  get(@Param("orderId") orderId: string) {
    return this.reservations.get(orderId);
  }

  @Post(":orderId/commit")
  @HttpCode(200)
  commit(@Param("orderId") orderId: string, @Req() req: Request) {
    return this.reservations.commit(orderId, req.requestId);
  }

  @Post(":orderId/release")
  @HttpCode(200)
  release(@Param("orderId") orderId: string, @Req() req: Request) {
    return this.reservations.release(orderId, req.requestId);
  }
}

// Checked here as well as at the gateway (§10).
@Roles("admin")
@Controller("admin")
export class AdminStockController {
  constructor(private readonly stock: StockService) {}

  @Get("stock")
  list(@Query() query: ListStockQuery) {
    return this.stock.list(query);
  }

  @Get("stock/export.csv")
  async export(@Res() res: Response) {
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="tej-stock-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(await this.stock.exportCsv());
  }

  @Post("stock")
  createPackaging(@CurrentUser() user: RequestUser, @Req() req: Request, @Body() dto: CreatePackagingDto) {
    return this.stock.createPackaging(actor(user, req), dto);
  }

  @Get("stock/:id")
  get(@Param("id", uuid) id: string) {
    return this.stock.get(id);
  }

  @Patch("stock/:id")
  update(@CurrentUser() user: RequestUser, @Req() req: Request, @Param("id", uuid) id: string, @Body() dto: UpdateStockDto) {
    return this.stock.update(actor(user, req), id, dto);
  }

  @Post("stock/:id/receive")
  @HttpCode(200)
  receive(@CurrentUser() user: RequestUser, @Req() req: Request, @Param("id", uuid) id: string, @Body() dto: ReceiveDto) {
    return this.stock.receive(actor(user, req), id, dto);
  }

  @Post("stock/:id/adjust")
  @HttpCode(200)
  adjust(@CurrentUser() user: RequestUser, @Req() req: Request, @Param("id", uuid) id: string, @Body() dto: AdjustDto) {
    return this.stock.adjust(actor(user, req), id, dto);
  }

  @Get("stock/:id/movements")
  movements(@Param("id", uuid) id: string, @Query() query: MovementsQuery) {
    return this.stock.movements(id, query.limit, query.cursor);
  }

  @Get("reservations")
  reservations(@Query() query: ReservationsQuery) {
    return this.stock.reservations(query);
  }
}
