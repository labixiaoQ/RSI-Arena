CREATE TABLE `artifacts` (
	`digest` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`kind` text NOT NULL,
	`object_id` text NOT NULL,
	`bytes` integer NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `artifact_identity` ON `artifacts` (`job_id`,`kind`,`object_id`);--> statement-breakpoint
CREATE TABLE `job_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job_id` text NOT NULL,
	`kind` text NOT NULL,
	`actor` text NOT NULL,
	`at` text NOT NULL,
	`data` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`title` text NOT NULL,
	`description` text NOT NULL,
	`executor` text NOT NULL,
	`improver` text NOT NULL,
	`visibility` integer NOT NULL,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`manifest` text NOT NULL,
	`manifest_digest` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`request_digest` text NOT NULL,
	`approval` text,
	`rejection_reason` text,
	`worker_id` text,
	`claim_id` text,
	`lease_id` text,
	`lease_epoch` integer DEFAULT 0 NOT NULL,
	`lease_until` integer,
	`seq` integer DEFAULT 0 NOT NULL,
	`phase` text,
	`budget` text NOT NULL,
	`unknown_operations` text DEFAULT '[]' NOT NULL,
	`finalization_digest` text,
	`experiment_artifact` text,
	`finished_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `owner_idempotency` ON `jobs` (`owner`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `job_queue` ON `jobs` (`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `runners` (
	`id` text PRIMARY KEY NOT NULL,
	`last_seen` integer NOT NULL,
	`capabilities` text NOT NULL
);
