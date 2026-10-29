// The offline brain's bridge to llama.cpp (OfflineBrain.java): load a GGUF model, then answer one conversation at a
// time, streaming the reply back piece by piece. Follows llama.cpp's own Android example (examples/llama.android).
// Text crosses to Java as UTF-8 bytes: JNI's own strings can't carry emoji.
#include <jni.h>
#include <android/log.h>

#ifdef LIGHTMOON_NO_LLAMA

// Built for a processor llama.cpp isn't built for here (CMakeLists.txt): the offline brain says it's unavailable.
extern "C" JNIEXPORT jboolean JNICALL
Java_app_lightmoon_assistant_OfflineBrain_nativeInit(JNIEnv *, jclass, jstring) { return JNI_FALSE; }
extern "C" JNIEXPORT jlong JNICALL
Java_app_lightmoon_assistant_OfflineBrain_nativeLoad(JNIEnv *, jclass, jstring, jint) { return 0; }
extern "C" JNIEXPORT jbyteArray JNICALL
Java_app_lightmoon_assistant_OfflineBrain_nativeComplete(JNIEnv *, jclass, jlong, jobjectArray, jobjectArray, jint, jobject) { return nullptr; }
extern "C" JNIEXPORT void JNICALL
Java_app_lightmoon_assistant_OfflineBrain_nativeFree(JNIEnv *, jclass, jlong) {}

#else

#include <algorithm>
#include <string>
#include <unistd.h>
#include <vector>

#include "chat.h"
#include "common.h"
#include "llama.h"
#include "sampling.h"

#define TAG "LightMoonBrain"

constexpr int BATCH_SIZE = 512;
constexpr float TEMPERATURE = 0.3f;

struct Engine {
    llama_model *model = nullptr;
    llama_context *context = nullptr;
    common_chat_templates_ptr templates;
    int n_ctx = 0;
};

static void log_to_android(ggml_log_level level, const char *text, void *) {
    if (level >= GGML_LOG_LEVEL_WARN) __android_log_write(level >= GGML_LOG_LEVEL_ERROR ? ANDROID_LOG_ERROR : ANDROID_LOG_WARN, TAG, text);
}

static std::string utf8(JNIEnv *env, jstring text) {
    const char *chars = env->GetStringUTFChars(text, nullptr);
    std::string value(chars ? chars : "");
    env->ReleaseStringUTFChars(text, chars);
    return value;
}

static jbyteArray bytes(JNIEnv *env, const std::string &text) {
    jbyteArray array = env->NewByteArray((jsize) text.size());
    env->SetByteArrayRegion(array, 0, (jsize) text.size(), (const jbyte *) text.data());
    return array;
}

// A token's text can end in the middle of a character; it's held back until the character is complete.
static bool complete_utf8(const std::string &text) {
    size_t i = 0;
    while (i < text.size()) {
        unsigned char c = text[i];
        size_t n = c < 0x80 ? 1 : (c >> 5) == 0x6 ? 2 : (c >> 4) == 0xE ? 3 : (c >> 3) == 0x1E ? 4 : 0;
        if (n == 0) return true; // not UTF-8 at all: pass it on rather than hold it forever
        if (i + n > text.size()) return false;
        i += n;
    }
    return true;
}

// Once per process: load the best CPU variant for this phone (they ship as separate libraries) and start llama.cpp.
extern "C" JNIEXPORT jboolean JNICALL
Java_app_lightmoon_assistant_OfflineBrain_nativeInit(JNIEnv *env, jclass, jstring native_lib_dir) {
    llama_log_set(log_to_android, nullptr);
    ggml_backend_load_all_from_path(utf8(env, native_lib_dir).c_str());
    llama_backend_init();
    return JNI_TRUE;
}

// Loads the model; returns a handle for the other calls, or 0 if it couldn't be loaded.
extern "C" JNIEXPORT jlong JNICALL
Java_app_lightmoon_assistant_OfflineBrain_nativeLoad(JNIEnv *env, jclass, jstring model_path, jint n_ctx) {
    llama_model *model = llama_model_load_from_file(utf8(env, model_path).c_str(), llama_model_default_params());
    if (!model) return 0;
    const int threads = std::max(2, std::min(4, (int) sysconf(_SC_NPROCESSORS_ONLN) - 2));
    llama_context_params params = llama_context_default_params();
    params.n_ctx = n_ctx;
    params.n_batch = BATCH_SIZE;
    params.n_ubatch = BATCH_SIZE;
    params.n_threads = threads;
    params.n_threads_batch = threads;
    llama_context *context = llama_init_from_model(model, params);
    if (!context) {
        llama_model_free(model);
        return 0;
    }
    auto *engine = new Engine();
    engine->model = model;
    engine->context = context;
    engine->templates = common_chat_templates_init(model, "");
    engine->n_ctx = n_ctx;
    return (jlong) engine;
}

// Answers a conversation (roles and contents, oldest first, ending with the user's turn), at most max_tokens long.
// Each finished piece of text goes to sink.onToken(byte[]); returning false there stops the answer early.
extern "C" JNIEXPORT jbyteArray JNICALL
Java_app_lightmoon_assistant_OfflineBrain_nativeComplete(JNIEnv *env, jclass, jlong handle, jobjectArray roles,
                                                         jobjectArray contents, jint max_tokens, jobject sink) {
    auto *engine = (Engine *) handle;
    if (!engine) return nullptr;
    llama_memory_clear(llama_get_memory(engine->context), false);

    // The whole conversation in the model's own chat format.
    const bool templated = common_chat_templates_was_explicit(engine->templates.get());
    const jsize count = env->GetArrayLength(roles);
    std::vector<common_chat_msg> past;
    std::string prompt;
    for (jsize i = 0; i < count; i++) {
        common_chat_msg message;
        message.role = utf8(env, (jstring) env->GetObjectArrayElement(roles, i));
        message.content = utf8(env, (jstring) env->GetObjectArrayElement(contents, i));
        prompt += templated
            ? common_chat_format_single(engine->templates.get(), past, message, i == count - 1, false)
            : message.content + "\n";
        past.push_back(message);
    }
    std::vector<llama_token> tokens = common_tokenize(engine->context, prompt, true, true);
    const int room = engine->n_ctx - max_tokens - 8; // keep the end (the question) if it's too long
    if ((int) tokens.size() > room) tokens.erase(tokens.begin(), tokens.end() - std::max(room, 1));

    common_batch batch(engine->context);
    const int n = (int) tokens.size();
    for (int i = 0; i < n; i += BATCH_SIZE) {
        batch.clear();
        for (int j = i; j < std::min(n, i + BATCH_SIZE); j++) batch.add(tokens[j], j, 0, j == n - 1);
        if (llama_process(engine->context, LLAMA_PROCESS_TYPE_DECODE, batch.get()) != 0) return nullptr;
    }

    jmethodID on_token = sink ? env->GetMethodID(env->GetObjectClass(sink), "onToken", "([B)Z") : nullptr;
    common_params_sampling sampling;
    sampling.temp = TEMPERATURE;
    common_sampler *sampler = common_sampler_init(engine->model, sampling);
    const llama_vocab *vocab = llama_model_get_vocab(engine->model);
    std::string reply;
    std::string held;
    int position = n;
    for (int k = 0; k < max_tokens && position < engine->n_ctx - 4; k++) {
        const llama_token token = common_sampler_sample(sampler, engine->context, -1);
        common_sampler_accept(sampler, token, true);
        if (llama_vocab_is_eog(vocab, token)) break;
        held += common_token_to_piece(engine->context, token);
        if (complete_utf8(held)) {
            reply += held;
            bool more = true;
            if (on_token) {
                jbyteArray piece = bytes(env, held);
                more = env->CallBooleanMethod(sink, on_token, piece);
                env->DeleteLocalRef(piece);
            }
            held.clear();
            if (!more) break;
        }
        batch.clear();
        batch.add(token, position++, 0, true);
        if (llama_process(engine->context, LLAMA_PROCESS_TYPE_DECODE, batch.get()) != 0) break;
    }
    common_sampler_free(sampler);
    return bytes(env, reply);
}

extern "C" JNIEXPORT void JNICALL
Java_app_lightmoon_assistant_OfflineBrain_nativeFree(JNIEnv *, jclass, jlong handle) {
    auto *engine = (Engine *) handle;
    if (!engine) return;
    engine->templates.reset();
    llama_free(engine->context);
    llama_model_free(engine->model);
    delete engine;
}

#endif
