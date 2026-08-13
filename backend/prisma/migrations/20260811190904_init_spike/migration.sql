-- CreateEnum
CREATE TYPE "spike_role" AS ENUM ('BROADCASTER', 'VIEWER');

-- CreateEnum
CREATE TYPE "network_type" AS ENUM ('WIFI', 'CELLULAR_5G', 'CELLULAR_4G', 'CELLULAR_3G', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "spike_event_type" AS ENUM ('SESSION_START', 'ROOM_CONNECTING', 'ROOM_CONNECTED', 'ROOM_RECONNECTING', 'ROOM_RECONNECTED', 'ROOM_DISCONNECTED', 'TRACK_PUBLISHED', 'TRACK_SUBSCRIBED', 'TRACK_UNSUBSCRIBED', 'FIRST_FRAME', 'NETWORK_CHANGED', 'QUALITY_CHANGED', 'ERROR', 'SESSION_END');

-- CreateTable
CREATE TABLE "spike_sessions" (
    "id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "room_name" TEXT NOT NULL,
    "carrier" TEXT,
    "network_type" "network_type" NOT NULL DEFAULT 'UNKNOWN',
    "location_note" TEXT,
    "broadcaster_device" JSONB,
    "viewer_device" JSONB,
    "notes" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMP(3),

    CONSTRAINT "spike_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "spike_samples" (
    "id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "role" "spike_role" NOT NULL,
    "seq" INTEGER NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,
    "probe_latency_ms" INTEGER,
    "estimated_e2e_ms" INTEGER,
    "rtt_ms" INTEGER,
    "jitter_ms" INTEGER,
    "packets_lost" INTEGER,
    "packet_loss_pct" DOUBLE PRECISION,
    "jitter_buffer_delay_ms" INTEGER,
    "frames_decoded" INTEGER,
    "frames_dropped" INTEGER,
    "freeze_count" INTEGER,
    "bitrate_kbps" INTEGER,
    "fps" DOUBLE PRECISION,
    "frame_width" INTEGER,
    "frame_height" INTEGER,
    "video_layer" TEXT,
    "connection_quality" TEXT,
    "network_type" "network_type" NOT NULL DEFAULT 'UNKNOWN',
    "carrier" TEXT,
    "clock_offset_ms" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "spike_samples_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "spike_events" (
    "id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "role" "spike_role" NOT NULL,
    "type" "spike_event_type" NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,
    "duration_ms" INTEGER,
    "detail" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "spike_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "glass_to_glass_measurements" (
    "id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "latency_ms" INTEGER NOT NULL,
    "paired_estimated_e2e_ms" INTEGER,
    "method" TEXT NOT NULL DEFAULT 'overlay_photo',
    "network_type" "network_type" NOT NULL DEFAULT 'UNKNOWN',
    "carrier" TEXT,
    "photo_ref" TEXT,
    "note" TEXT,
    "measured_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "glass_to_glass_measurements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "livekit_webhook_events" (
    "id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "room_name" TEXT,
    "participant_id" TEXT,
    "payload" JSONB NOT NULL,
    "signature_valid" BOOLEAN NOT NULL,
    "processed_at" TIMESTAMP(3),
    "error" TEXT,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "livekit_webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "spike_sessions_room_name_key" ON "spike_sessions"("room_name");

-- CreateIndex
CREATE INDEX "spike_sessions_started_at_idx" ON "spike_sessions"("started_at");

-- CreateIndex
CREATE INDEX "spike_samples_session_id_role_at_idx" ON "spike_samples"("session_id", "role", "at");

-- CreateIndex
CREATE INDEX "spike_events_session_id_at_idx" ON "spike_events"("session_id", "at");

-- CreateIndex
CREATE INDEX "spike_events_type_idx" ON "spike_events"("type");

-- CreateIndex
CREATE INDEX "glass_to_glass_measurements_session_id_idx" ON "glass_to_glass_measurements"("session_id");

-- CreateIndex
CREATE INDEX "livekit_webhook_events_room_name_received_at_idx" ON "livekit_webhook_events"("room_name", "received_at");

-- CreateIndex
CREATE UNIQUE INDEX "livekit_webhook_events_event_id_key" ON "livekit_webhook_events"("event_id");

-- AddForeignKey
ALTER TABLE "spike_samples" ADD CONSTRAINT "spike_samples_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "spike_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "spike_events" ADD CONSTRAINT "spike_events_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "spike_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "glass_to_glass_measurements" ADD CONSTRAINT "glass_to_glass_measurements_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "spike_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
