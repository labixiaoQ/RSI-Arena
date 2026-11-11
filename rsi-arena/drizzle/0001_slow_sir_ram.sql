DROP INDEX `artifact_identity`;--> statement-breakpoint
CREATE UNIQUE INDEX `artifact_identity` ON `artifacts` (`kind`,`object_id`);