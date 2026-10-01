cmake_minimum_required(VERSION 3.16)
project(webscope-backend LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

if(NOT CMAKE_BUILD_TYPE AND NOT CMAKE_CONFIGURATION_TYPES)
  set(CMAKE_BUILD_TYPE Release)
endif()

# Boost.Beast is header-only (needs Boost >= 1.70)
if(POLICY CMP0167)
  cmake_policy(SET CMP0167 NEW)
endif()
find_package(Boost 1.70 REQUIRED)
find_package(Threads REQUIRED)

# libsigrok C++ bindings (pulls in libsigrok, glibmm, libusb, ...)
find_package(PkgConfig REQUIRED)
pkg_check_modules(SIGROKCXX REQUIRED IMPORTED_TARGET libsigrokcxx)

# nlohmann/json: use system copy if present, otherwise download it
find_package(nlohmann_json 3.9 QUIET)
if(NOT nlohmann_json_FOUND)
  include(FetchContent)
  FetchContent_Declare(json
    URL https://github.com/nlohmann/json/releases/download/v3.11.3/json.tar.xz)
  FetchContent_MakeAvailable(json)
endif()

add_executable(webscope-backend
  src/main.cpp
  src/server.cpp
  src/sigrok_backend.cpp)

target_include_directories(webscope-backend PRIVATE src)
target_link_libraries(webscope-backend PRIVATE
  Boost::headers
  Threads::Threads
  PkgConfig::SIGROKCXX
  nlohmann_json::nlohmann_json)

if(MSVC)
  target_compile_options(webscope-backend PRIVATE /W4)
else()
  target_compile_options(webscope-backend PRIVATE -Wall -Wextra)
endif()

if(WIN32)
  target_compile_definitions(webscope-backend PRIVATE _WIN32_WINNT=0x0A00)
  target_link_libraries(webscope-backend PRIVATE ws2_32 mswsock)
endif()

install(TARGETS webscope-backend RUNTIME DESTINATION bin)
