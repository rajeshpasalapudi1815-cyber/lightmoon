package app.lightmoon.assistant;

import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.SecureRandom;
import javax.crypto.Cipher;
import javax.crypto.Mac;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

// Opens and seals the sync copy exactly as docs/js/vault.js does: an AES-256-GCM key from HKDF-SHA256 of the
// sync code (salt "lightmoon-sync", info "data-key-v1"); the payload is a 12-byte IV followed by the ciphertext.
final class CloudCrypto {

    private static final SecureRandom RANDOM = new SecureRandom();

    private CloudCrypto() {}

    static String decrypt(String syncCode, byte[] payload) throws GeneralSecurityException {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, key(syncCode), new GCMParameterSpec(128, payload, 0, 12));
        return new String(cipher.doFinal(payload, 12, payload.length - 12), StandardCharsets.UTF_8);
    }

    static byte[] encrypt(String syncCode, String text) throws GeneralSecurityException {
        byte[] iv = new byte[12];
        RANDOM.nextBytes(iv);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, key(syncCode), new GCMParameterSpec(128, iv));
        byte[] sealed = cipher.doFinal(bytes(text));
        byte[] payload = new byte[iv.length + sealed.length];
        System.arraycopy(iv, 0, payload, 0, iv.length);
        System.arraycopy(sealed, 0, payload, iv.length, sealed.length);
        return payload;
    }

    private static SecretKeySpec key(String syncCode) throws GeneralSecurityException {
        return new SecretKeySpec(hkdf(bytes(syncCode), bytes("lightmoon-sync"), bytes("data-key-v1"), 32), "AES");
    }

    static byte[] hkdf(byte[] inputKey, byte[] salt, byte[] info, int length) throws GeneralSecurityException {
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(salt, "HmacSHA256"));
        byte[] pseudoRandomKey = mac.doFinal(inputKey);
        mac.init(new SecretKeySpec(pseudoRandomKey, "HmacSHA256"));
        byte[] output = new byte[length];
        byte[] block = new byte[0];
        int written = 0;
        for (int counter = 1; written < length; counter++) {
            mac.update(block);
            mac.update(info);
            mac.update((byte) counter);
            block = mac.doFinal();
            int count = Math.min(block.length, length - written);
            System.arraycopy(block, 0, output, written, count);
            written += count;
        }
        return output;
    }

    private static byte[] bytes(String text) {
        return text.getBytes(StandardCharsets.UTF_8);
    }
}
