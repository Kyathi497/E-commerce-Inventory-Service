-- CreateTable
CREATE TABLE `StockItem` (
    `id` VARCHAR(191) NOT NULL,
    `kind` ENUM('product', 'packaging') NOT NULL,
    `refId` VARCHAR(64) NOT NULL,
    `name` VARCHAR(120) NOT NULL,
    `unit` ENUM('g', 'ml', 'pcs') NOT NULL DEFAULT 'g',
    `onHand` INTEGER NOT NULL DEFAULT 0,
    `reserved` INTEGER NOT NULL DEFAULT 0,
    `lowStockThreshold` INTEGER NOT NULL DEFAULT 2000,
    `status` ENUM('active', 'archived') NOT NULL DEFAULT 'active',
    `version` INTEGER NOT NULL DEFAULT 1,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `StockItem_status_idx`(`status`),
    UNIQUE INDEX `StockItem_kind_refId_key`(`kind`, `refId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Reservation` (
    `id` VARCHAR(191) NOT NULL,
    `orderId` VARCHAR(64) NOT NULL,
    `status` ENUM('held', 'committed', 'released', 'expired') NOT NULL DEFAULT 'held',
    `expiresAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `Reservation_orderId_key`(`orderId`),
    INDEX `Reservation_status_expiresAt_idx`(`status`, `expiresAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ReservationLine` (
    `id` VARCHAR(191) NOT NULL,
    `reservationId` VARCHAR(191) NOT NULL,
    `stockItemId` VARCHAR(191) NOT NULL,
    `quantity` INTEGER NOT NULL,

    INDEX `ReservationLine_reservationId_idx`(`reservationId`),
    INDEX `ReservationLine_stockItemId_idx`(`stockItemId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `StockMovement` (
    `id` VARCHAR(191) NOT NULL,
    `stockItemId` VARCHAR(191) NOT NULL,
    `onHandDelta` INTEGER NOT NULL,
    `reservedDelta` INTEGER NOT NULL,
    `reason` ENUM('receive', 'adjust', 'damage', 'return', 'reserve', 'commit', 'release', 'expire') NOT NULL,
    `refType` VARCHAR(32) NULL,
    `refId` VARCHAR(64) NULL,
    `actorId` VARCHAR(191) NULL,
    `note` VARCHAR(300) NULL,
    `at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `StockMovement_stockItemId_at_idx`(`stockItemId`, `at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AuditLog` (
    `id` VARCHAR(191) NOT NULL,
    `actorId` VARCHAR(191) NULL,
    `action` VARCHAR(64) NOT NULL,
    `target` VARCHAR(191) NULL,
    `at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `meta` JSON NULL,

    INDEX `AuditLog_target_idx`(`target`),
    INDEX `AuditLog_at_idx`(`at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `OutboxEvent` (
    `id` CHAR(36) NOT NULL,
    `type` VARCHAR(64) NOT NULL,
    `version` INTEGER NOT NULL,
    `payload` JSON NOT NULL,
    `correlationId` VARCHAR(128) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `OutboxEvent_createdAt_idx`(`createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `OutboxDelivery` (
    `eventId` CHAR(36) NOT NULL,
    `consumer` VARCHAR(64) NOT NULL,
    `status` ENUM('pending', 'delivered', 'failed') NOT NULL DEFAULT 'pending',
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `nextAttemptAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `lastError` VARCHAR(500) NULL,
    `deliveredAt` DATETIME(3) NULL,

    INDEX `OutboxDelivery_status_nextAttemptAt_idx`(`status`, `nextAttemptAt`),
    PRIMARY KEY (`eventId`, `consumer`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ProcessedEvent` (
    `eventId` CHAR(36) NOT NULL,
    `type` VARCHAR(64) NOT NULL,
    `processedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`eventId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `ReservationLine` ADD CONSTRAINT `ReservationLine_reservationId_fkey` FOREIGN KEY (`reservationId`) REFERENCES `Reservation`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ReservationLine` ADD CONSTRAINT `ReservationLine_stockItemId_fkey` FOREIGN KEY (`stockItemId`) REFERENCES `StockItem`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `StockMovement` ADD CONSTRAINT `StockMovement_stockItemId_fkey` FOREIGN KEY (`stockItemId`) REFERENCES `StockItem`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `OutboxDelivery` ADD CONSTRAINT `OutboxDelivery_eventId_fkey` FOREIGN KEY (`eventId`) REFERENCES `OutboxEvent`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- Last line of defence against overselling (§6.4): the database itself refuses
-- negative stock or more reserved than is on hand.
ALTER TABLE `StockItem` ADD CONSTRAINT `StockItem_levels_check`
    CHECK (`onHand` >= 0 AND `reserved` >= 0 AND `reserved` <= `onHand`);
