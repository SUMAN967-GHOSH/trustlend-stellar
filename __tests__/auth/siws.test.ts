import { describe, it, expect, beforeAll, vi } from "vitest";
import { Keypair, Transaction } from "@stellar/stellar-sdk";

const SERVER_SECRET_KEY = Keypair.random();
const DOMAIN = "localhost:3000";

// SEP-10 relies on env for the server key + domain; set before importing the module.
process.env.SIWS_SERVER_SECRET = SERVER_SECRET_KEY.secret();
process.env.NEXT_PUBLIC_SIWS_DOMAIN = DOMAIN;
process.env.NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";

let buildChallenge: typeof import("@/lib/auth/siws-server").buildChallenge;
let verifyChallenge: typeof import("@/lib/auth/siws-server").verifyChallenge;
let SiwsError: typeof import("@/lib/auth/siws-server").SiwsError;
let getServerSigningKey: typeof import("@/lib/auth/siws-server").getServerSigningKey;

beforeAll(async () => {
  const mod = await import("@/lib/auth/siws-server");
  buildChallenge = mod.buildChallenge;
  verifyChallenge = mod.verifyChallenge;
  SiwsError = mod.SiwsError;
  getServerSigningKey = mod.getServerSigningKey;
});

function signChallenge(xdr: string, signer: Keypair) {
  const tx = new Transaction(xdr, "Test SDF Network ; September 2015");
  tx.sign(signer);
  return tx.toEnvelope().toXDR("base64");
}

describe("SIWS server: buildChallenge", () => {
  it("rejects an invalid address before touching the network", () => {
    expect(() => buildChallenge("not-a-real-address")).toThrow(SiwsError);
  });

  it("builds a challenge transaction signed by the server key", () => {
    const client = Keypair.random();
    const { transaction, networkPassphrase } = buildChallenge(client.publicKey());
    expect(typeof transaction).toBe("string");
    expect(transaction.length).toBeGreaterThan(50);
    expect(networkPassphrase).toBe("Test SDF Network ; September 2015");
  });

  it("exposes the server signing key", () => {
    expect(getServerSigningKey()).toBe(SERVER_SECRET_KEY.publicKey());
  });
});

describe("SIWS server: verifyChallenge (happy path)", () => {
  it("accepts a properly signed, matching challenge", () => {
    const client = Keypair.random();
    const { transaction } = buildChallenge(client.publicKey());
    const signed = signChallenge(transaction, client);

    const verified = verifyChallenge(signed, client.publicKey());
    expect(verified).toBe(client.publicKey());
  });
});

describe("SIWS server: verifyChallenge (error states)", () => {
  it("rejects a challenge signed by the wrong wallet", () => {
    const client = Keypair.random();
    const impostor = Keypair.random();
    const { transaction } = buildChallenge(client.publicKey());
    const signed = signChallenge(transaction, impostor);

    expect(() => verifyChallenge(signed, client.publicKey())).toThrow(SiwsError);
    try {
      verifyChallenge(signed, client.publicKey());
    } catch (err) {
      expect((err as InstanceType<typeof SiwsError>).code).toBe("invalid_signature");
    }
  });

  it("rejects when the claimed address doesn't match the challenge's account", () => {
    const client = Keypair.random();
    const other = Keypair.random();
    const { transaction } = buildChallenge(client.publicKey());
    const signed = signChallenge(transaction, client);

    // Claiming to be `other` while the challenge/signature belong to `client`.
    expect(() => verifyChallenge(signed, other.publicKey())).toThrow(SiwsError);
    try {
      verifyChallenge(signed, other.publicKey());
    } catch (err) {
      expect((err as InstanceType<typeof SiwsError>).code).toBe("address_mismatch");
    }
  });

  it("rejects malformed XDR", () => {
    const client = Keypair.random();
    expect(() => verifyChallenge("not-valid-xdr", client.publicKey())).toThrow(SiwsError);
    try {
      verifyChallenge("not-valid-xdr", client.publicKey());
    } catch (err) {
      expect((err as InstanceType<typeof SiwsError>).code).toBe("invalid_challenge");
    }
  });

  it("rejects an invalid target address up front", () => {
    const client = Keypair.random();
    const { transaction } = buildChallenge(client.publicKey());
    const signed = signChallenge(transaction, client);

    expect(() => verifyChallenge(signed, "bad-address")).toThrow(SiwsError);
  });

  it("rejects an expired challenge", async () => {
    const { WebAuth } = await import("@stellar/stellar-sdk");
    const client = Keypair.random();
    const expiredTx = WebAuth.buildChallengeTx(
      SERVER_SECRET_KEY,
      client.publicKey(),
      DOMAIN,
      1, // 1-second validity window
      "Test SDF Network ; September 2015",
      DOMAIN
    );
    const signed = signChallenge(expiredTx, client);
    // Wait comfortably past the 1s window (timer jitter can shave the edge).
    await new Promise((r) => setTimeout(r, 3000));

    let caught: unknown;
    try {
      verifyChallenge(signed, client.publicKey());
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SiwsError);
    expect((caught as InstanceType<typeof SiwsError>).code).toBe("expired_challenge");
  }, 10_000);
});

describe("SIWS server: not_configured guard", () => {
  it("throws not_configured when SIWS_SERVER_SECRET is missing", async () => {
    const original = process.env.SIWS_SERVER_SECRET;
    delete process.env.SIWS_SERVER_SECRET;
    vi.resetModules();
    try {
      const mod = await import("@/lib/auth/siws-server");
      expect(() => mod.buildChallenge(Keypair.random().publicKey())).toThrow(mod.SiwsError);
      try {
        mod.buildChallenge(Keypair.random().publicKey());
      } catch (err) {
        expect((err as InstanceType<typeof mod.SiwsError>).code).toBe("not_configured");
      }
    } finally {
      process.env.SIWS_SERVER_SECRET = original;
      vi.resetModules();
    }
  });
});
