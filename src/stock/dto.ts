import { Transform, Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBooleanString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  NotEquals,
  ValidateNested,
} from "class-validator";

const trim = () => Transform(({ value }) => (typeof value === "string" ? value.trim() : value));
// 1,000 kg: well above any real batch, low enough to catch a typo.
const MAX_QTY = 1_000_000;

export class AvailabilityQuery {
  // Comma-separated catalog product ids (100 UUIDs fit well inside this).
  @IsString() @MaxLength(4000) products: string;
}

export class AvailabilityDto {
  // Catalog product ids; the service answers for at most 100 per call.
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @IsString({ each: true }) @Length(1, 64, { each: true }) products: string[];
}

export class ReserveLineDto {
  @IsOptional() @IsIn(["product", "packaging"]) kind?: "product" | "packaging";
  @IsString() @Length(1, 64) refId: string;
  @IsInt() @Min(1) @Max(MAX_QTY) quantity: number;
}

export class ReserveDto {
  @IsString() @Matches(/^[\w.:-]{1,64}$/, { message: "Use letters, numbers, dots, colons and dashes." }) orderId: string;
  @ValidateNested({ each: true }) @Type(() => ReserveLineDto) @ArrayMinSize(1) @ArrayMaxSize(100) lines: ReserveLineDto[];
  @IsOptional() @IsInt() @Min(60) @Max(3600) ttlSeconds?: number;
}

export class ListStockQuery {
  @IsOptional() @IsIn(["product", "packaging"]) kind?: "product" | "packaging";
  // Only items at or below their low-stock threshold.
  @IsOptional() @IsBooleanString() low?: string;
  @IsOptional() @trim() @IsString() @MaxLength(100) q?: string;
  @IsOptional() @IsIn(["active", "archived"]) status?: "active" | "archived";
}

export class ReceiveDto {
  @IsInt() @Min(1) @Max(MAX_QTY) quantity: number;
  @IsOptional() @trim() @IsString() @MaxLength(300) note?: string;
}

export class AdjustDto {
  // Negative to remove stock, positive to add.
  @IsInt() @NotEquals(0) @Min(-MAX_QTY) @Max(MAX_QTY) delta: number;
  @IsIn(["adjust", "damage", "return"]) reason: "adjust" | "damage" | "return";
  @trim() @IsString() @Length(3, 300, { message: "Say why, in a few words." }) note: string;
}

export class UpdateStockDto {
  @IsInt() @Min(1) version: number;
  @IsOptional() @IsInt() @Min(0) @Max(MAX_QTY) lowStockThreshold?: number;
  @IsOptional() @trim() @IsString() @Length(2, 120) name?: string;
  @IsOptional() @IsIn(["active", "archived"]) status?: "active" | "archived";
}

export class CreatePackagingDto {
  @trim() @Matches(/^[A-Z0-9]+(?:-[A-Z0-9]+)*$/, { message: "Use capitals, numbers and dashes, e.g. JAR-1KG." }) @MaxLength(64)
  code: string;
  @trim() @IsString() @Length(2, 120) name: string;
  @IsOptional() @IsInt() @Min(0) @Max(MAX_QTY) lowStockThreshold?: number;
}

export class MovementsQuery {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit?: number;
  @IsOptional() @IsString() @MaxLength(200) cursor?: string;
}

export class ReservationsQuery {
  @IsOptional() @IsIn(["held", "committed", "released", "expired"]) status?: "held" | "committed" | "released" | "expired";
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit?: number;
  @IsOptional() @IsString() @MaxLength(200) cursor?: string;
}
