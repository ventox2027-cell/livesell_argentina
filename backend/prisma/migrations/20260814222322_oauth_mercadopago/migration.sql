-- CreateTable
CREATE TABLE "oauth_states" (
    "id" TEXT NOT NULL,
    "seller_id" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "provider" "PaymentProvider" NOT NULL DEFAULT 'MERCADO_PAGO',
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "oauth_states_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "seller_oauth_credentials" (
    "id" TEXT NOT NULL,
    "seller_id" TEXT NOT NULL,
    "provider" "PaymentProvider" NOT NULL DEFAULT 'MERCADO_PAGO',
    "access_ciphertext" TEXT NOT NULL,
    "access_iv" TEXT NOT NULL,
    "access_tag" TEXT NOT NULL,
    "refresh_ciphertext" TEXT,
    "refresh_iv" TEXT,
    "refresh_tag" TEXT,
    "key_version" INTEGER NOT NULL DEFAULT 1,
    "access_hint" TEXT,
    "expires_at" TIMESTAMP(3),
    "refreshed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "seller_oauth_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "oauth_states_state_key" ON "oauth_states"("state");

-- CreateIndex
CREATE INDEX "oauth_states_expires_at_idx" ON "oauth_states"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "seller_oauth_credentials_seller_id_provider_key" ON "seller_oauth_credentials"("seller_id", "provider");

-- AddForeignKey
ALTER TABLE "oauth_states" ADD CONSTRAINT "oauth_states_seller_id_fkey" FOREIGN KEY ("seller_id") REFERENCES "sellers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "seller_oauth_credentials" ADD CONSTRAINT "seller_oauth_credentials_seller_id_fkey" FOREIGN KEY ("seller_id") REFERENCES "sellers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- El refresh token va entero o no va.
--
-- Con el texto cifrado presente y el IV nulo -o al reves- la fila es basura
-- que sólo se descubre al intentar renovar el token, seis meses despues, con
-- el vendedor sin poder cobrar y sin ninguna pista de por que.
ALTER TABLE "seller_oauth_credentials"
  ADD CONSTRAINT "credenciales_refresh_completo_check"
  CHECK (
    ("refresh_ciphertext" IS NULL AND "refresh_iv" IS NULL AND "refresh_tag" IS NULL)
    OR ("refresh_ciphertext" IS NOT NULL AND "refresh_iv" IS NOT NULL AND "refresh_tag" IS NOT NULL)
  );

-- La pista es una pista, no el token.
--
-- Guarda los ultimos cuatro caracteres para que soporte pueda hablar del token
-- sin exponerlo. Un limite de largo evita que alguien "arregle" el codigo para
-- guardar el token entero en esta columna, que es exactamente lo que la tabla
-- existe para impedir.
ALTER TABLE "seller_oauth_credentials"
  ADD CONSTRAINT "credenciales_pista_corta_check"
  CHECK ("access_hint" IS NULL OR length("access_hint") <= 12);
