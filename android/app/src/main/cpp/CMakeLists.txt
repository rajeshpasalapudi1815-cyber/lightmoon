# The offline brain's native side: llama.cpp (a pinned release, fetched and checked at build time) and the small
# bridge LightMoon calls (lightmoon_llm.cpp, used by OfflineBrain.java). 64-bit ARM phones only; on other processors
# the bridge is built without llama.cpp and says the offline brain isn't available.
cmake_minimum_required(VERSION 3.22.1)
project(lightmoon-llm C CXX)

set(CMAKE_C_STANDARD 11)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

if(NOT ANDROID_ABI STREQUAL "arm64-v8a")
    add_library(lightmoon-llm SHARED lightmoon_llm.cpp)
    target_compile_definitions(lightmoon-llm PRIVATE LIGHTMOON_NO_LLAMA)
    target_link_libraries(lightmoon-llm log)
    return()
endif()

# Like llama.cpp's own Android example: shared libraries, and every CPU variant built, the best one picked on the
# phone at start-up (ggml_backend_load_all_from_path). No HTTPS, tools, tests or examples.
set(BUILD_SHARED_LIBS ON CACHE BOOL "" FORCE)
set(LLAMA_BUILD_COMMON ON CACHE BOOL "" FORCE)
set(LLAMA_BUILD_APP OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_TOOLS OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_SERVER OFF CACHE BOOL "" FORCE)
set(LLAMA_OPENSSL OFF CACHE BOOL "" FORCE)
set(GGML_NATIVE OFF CACHE BOOL "" FORCE)
set(GGML_BACKEND_DL ON CACHE BOOL "" FORCE)
set(GGML_CPU_ALL_VARIANTS ON CACHE BOOL "" FORCE)
set(GGML_LLAMAFILE OFF CACHE BOOL "" FORCE)
set(GGML_OPENMP ON CACHE BOOL "" FORCE)
set(GGML_CPU_KLEIDIAI OFF CACHE BOOL "" FORCE)
set(GGML_SYSTEM_ARCH "ARM")

include(FetchContent)
FetchContent_Declare(llama_cpp
    URL https://github.com/ggml-org/llama.cpp/archive/refs/tags/v0.8.0.tar.gz
    URL_HASH SHA256=51b1e025d7b12e83fa55736e65bc254acd9d23e49f546be7531368fef82210ee)
FetchContent_MakeAvailable(llama_cpp)

add_library(lightmoon-llm SHARED lightmoon_llm.cpp)
target_include_directories(lightmoon-llm PRIVATE
    ${llama_cpp_SOURCE_DIR}/common
    ${llama_cpp_SOURCE_DIR}/include
    ${llama_cpp_SOURCE_DIR}/ggml/include)
target_link_libraries(lightmoon-llm llama llama-common android log)
