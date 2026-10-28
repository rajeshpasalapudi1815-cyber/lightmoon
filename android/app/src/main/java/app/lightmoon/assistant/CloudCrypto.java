package app.lightmoon.assistant;

import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import javax.crypto.Cipher;
import javax.crypto.Mac;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

// Decrypts the sync copy exactly as docs/js/vault.js encrypts it: an AES-256-GCM key from HKDF-SHA256 of the
// sync code (salt "lightmoon-sync", info "data-key-v1"); the payload is a 12-byte IV followed by the ciphertext.
final class CloudCrypto {

    private CloudCrypto() {}

    static String decrypt(String syncCode, byte[] payload) throws GeneralSecurityException {
        byte[] key = hkdf(bytes(syncCode), bytes("lightmoon-sync"), bytes("data-key-v1"), 32);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, new SecretKeySpec(key, "AES"), new GCMParameterSpec(128, payload, 0, 12));
        return new String(cipher.doFinal(payload, 12, payload.length - 12), StandardCharsets.UTF_8);
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
