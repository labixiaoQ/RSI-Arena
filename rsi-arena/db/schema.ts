import {sqliteTable,text,integer,uniqueIndex,index} from 'drizzle-orm/sqlite-core';
export const jobs=sqliteTable('jobs',{
 id:text('id').primaryKey(),owner:text('owner').notNull(),title:text('title').notNull(),description:text('description').notNull(),
 executor:text('executor').notNull(),improver:text('improver').notNull(),visibility:integer('visibility').notNull(),
 status:text('status').notNull(),createdAt:text('created_at').notNull(),updatedAt:text('updated_at').notNull(),
 manifest:text('manifest').notNull(),manifestDigest:text('manifest_digest').notNull(),idempotencyKey:text('idempotency_key').notNull(),requestDigest:text('request_digest').notNull(),
 approval:text('approval'),rejectionReason:text('rejection_reason'),workerId:text('worker_id'),claimId:text('claim_id'),leaseId:text('lease_id'),
 leaseEpoch:integer('lease_epoch').notNull().default(0),leaseUntil:integer('lease_until'),seq:integer('seq').notNull().default(0),phase:text('phase'),
 budget:text('budget').notNull(),unknownOperations:text('unknown_operations').notNull().default('[]'),finalizationDigest:text('finalization_digest'),experimentArtifact:text('experiment_artifact'),finishedAt:text('finished_at'),
},t=>[uniqueIndex('owner_idempotency').on(t.owner,t.idempotencyKey),index('job_queue').on(t.status,t.createdAt)]);
export const events=sqliteTable('job_events',{
 id:integer('id').primaryKey({autoIncrement:true}),jobId:text('job_id').notNull(),kind:text('kind').notNull(),actor:text('actor').notNull(),at:text('at').notNull(),data:text('data').notNull(),
});
export const artifacts=sqliteTable('artifacts',{
 digest:text('digest').primaryKey(),jobId:text('job_id').notNull(),kind:text('kind').notNull(),objectId:text('object_id').notNull(),bytes:integer('bytes').notNull(),createdAt:text('created_at').notNull(),
},t=>[uniqueIndex('artifact_identity').on(t.kind,t.objectId)]);
export const runners=sqliteTable('runners',{
 id:text('id').primaryKey(),lastSeen:integer('last_seen').notNull(),capabilities:text('capabilities').notNull(),
});
