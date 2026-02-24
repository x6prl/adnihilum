cmake_minimum_required(VERSION 3.13)
project(adnihilum VERSION 0.2.2 LANGUAGES C)

set(CMAKE_C_STANDARD 23)
set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)
set(CMAKE_C_FLAGS "${CMAKE_C_FLAGS} -O2")
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -O2")

# Build options
option(JS_MINIFY "Use minified JavaScript assets" OFF)
option(FILELOG "Enable logging into a file" OFF)
option(SYSLOG "Enable syslog logging" ON)
option(TRACY_ENABLE "Enable Tracy profiler instrumentation" OFF)
option(STATISTICS "Enable statistics" OFF)
option(LOCK_MEMORY_TO_RAM "Lock storage buffers in RAM with mlock" OFF)
option(TAILSCALE "Enable Tailscale-aware HTTP handling" OFF)
option(ASSEMBLED_HTML "Response with cliet_assembled.html" ON)
option(DEBOUNCER "Enable per-client request debouncing" ON)

option(SIMD_X86 "Enable x86 SIMD code paths" ON)
option(SIMD_ARM "Enable ARM NEON code paths" OFF)

set(_AD_NIHILUM_BUILD_OPTIONS
  JS_MINIFY
  FILELOG
  SYSLOG
  TRACY_ENABLE
  STATISTICS
  LOCK_MEMORY_TO_RAM
  TAILSCALE
  ASSEMBLED_HTML
  DEBOUNCER
  SIMD_X86
  SIMD_ARM
)
message(STATUS "Configuring adnihilum with the following options:")
foreach(_opt IN LISTS _AD_NIHILUM_BUILD_OPTIONS)
  message(STATUS "  ${_opt} = ${${_opt}}")
endforeach()
unset(_opt)
unset(_AD_NIHILUM_BUILD_OPTIONS)

if(CMAKE_BUILD_TYPE STREQUAL "Debug")
  set(CMAKE_C_FLAGS "-Og -g3 -pg -Wall -Wextra -fanalyzer -fsanitize=address,undefined -fno-omit-frame-pointer")
  message(STATUS "Debug C flags: " ${CMAKE_C_FLAGS})
endif()

# Try pkg-config first
find_package(PkgConfig QUIET)
if (PkgConfig_FOUND)
  pkg_check_modules(MHD libmicrohttpd)
endif()

set(AD_NIHILUM_GIT_BRANCH "")
set(_AD_NIHILUM_GIT_BRANCH_RESULT 1)
execute_process(
  COMMAND git rev-parse --abbrev-ref HEAD
  OUTPUT_VARIABLE AD_NIHILUM_GIT_BRANCH
  RESULT_VARIABLE _AD_NIHILUM_GIT_BRANCH_RESULT
  OUTPUT_STRIP_TRAILING_WHITESPACE
)
if(NOT _AD_NIHILUM_GIT_BRANCH_RESULT EQUAL 0)
  set(AD_NIHILUM_GIT_BRANCH "")
endif()

set(AD_NIHILUM_VERSION_DEV_SUFFIX "")
if(NOT AD_NIHILUM_GIT_BRANCH STREQUAL "master")
  set(AD_NIHILUM_VERSION_DEV_SUFFIX "-dev")
endif()

configure_file(version.h.in version.h @ONLY)

add_executable(adnihilum server.c storage.c log.c)
target_include_directories(adnihilum PRIVATE ${CMAKE_CURRENT_BINARY_DIR})
target_compile_definitions(adnihilum PRIVATE
  $<$<BOOL:${JS_MINIFY}>:JS_MINIFY=1>
  $<$<BOOL:${FILELOG}>:FILELOG=1>
  $<$<BOOL:${SYSLOG}>:SYSLOG=1>
  $<$<BOOL:${STATISTICS}>:STATISTICS=1>
  $<$<BOOL:${LOCK_MEMORY_TO_RAM}>:LOCK_MEMORY_TO_RAM=1>
  $<$<BOOL:${TAILSCALE}>:TAILSCALE=1>
  $<$<BOOL:${ASSEMBLED_HTML}>:ASSEMBLED_HTML=1>
  $<$<BOOL:${DEBOUNCER}>:DEBOUNCER=1>
  $<$<BOOL:${SIMD_X86}>:SIMD_X86=1>
  $<$<BOOL:${SIMD_ARM}>:SIMD_ARM=1>
  $<$<CONFIG:Debug>:DEBUG=1>
)

if(SIMD_X86)
  target_compile_options(adnihilum PRIVATE -mavx2)
endif()

if(TRACY_ENABLE)
  if(POLICY CMP0169)
    cmake_policy(SET CMP0169 OLD)
  endif()
  include(FetchContent)
  FetchContent_Declare(
    tracy
    GIT_REPOSITORY https://github.com/wolfpld/tracy.git
    GIT_TAG v0.12.2
    GIT_SHALLOW TRUE
  )
  FetchContent_Populate(tracy)
  enable_language(CXX)
  add_library(tracy-client STATIC ${tracy_SOURCE_DIR}/public/TracyClient.cpp)
  target_include_directories(tracy-client PUBLIC
    ${tracy_SOURCE_DIR}/public
    ${tracy_SOURCE_DIR}/public/tracy
  )
  target_compile_options(tracy-client PRIVATE -fno-omit-frame-pointer)
  target_compile_features(tracy-client PUBLIC cxx_std_17)
  target_compile_definitions(tracy-client PUBLIC TRACY_ENABLE)
  if(UNIX AND NOT APPLE)
    target_link_libraries(tracy-client PUBLIC dl)
  endif()
  target_link_libraries(adnihilum PRIVATE tracy-client)
  target_compile_options(adnihilum PRIVATE -fno-omit-frame-pointer)
  set_property(TARGET adnihilum PROPERTY LINKER_LANGUAGE CXX)
  target_compile_definitions(adnihilum PRIVATE TRACY_ENABLE)
endif()

if (MHD_FOUND)
  target_include_directories(adnihilum PRIVATE ${MHD_INCLUDE_DIRS})
  target_link_directories(adnihilum PRIVATE ${MHD_LIBRARY_DIRS})
  target_link_libraries(adnihilum PRIVATE ${MHD_LIBRARIES})
else()
  find_library(MHD_LIB microhttpd)
  if (NOT MHD_LIB)
    message(FATAL_ERROR "libmicrohttpd not found. Install libmicrohttpd-dev.")
  endif()
  target_link_libraries(adnihilum PRIVATE ${MHD_LIB})
endif()
