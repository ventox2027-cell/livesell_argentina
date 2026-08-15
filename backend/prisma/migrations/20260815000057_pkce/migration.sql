-- El verificador de PKCE.
--
-- Ata el CODIGO de autorizacion a la peticion que lo pidio, que es distinto de
-- lo que hace el state: aquel ata el callback a la persona. Si alguien
-- intercepta el codigo, sin el verificador no lo puede canjear — y el
-- verificador nunca viajo por el navegador, solo su hash.
ALTER TABLE "oauth_states" ADD COLUMN "code_verifier" TEXT;
