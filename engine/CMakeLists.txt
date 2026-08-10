cmake_minimum_required(VERSION 3.16)
project(ddos_engine LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

if(NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE Release)
endif()

add_executable(ddos_server
    src/main_server.cpp
    src/server/epoll_loop.cpp
    src/server/rate_limiter.cpp
    src/server/thread_pool.cpp
    src/telemetry/udp_broadcaster.cpp
)

target_include_directories(ddos_server PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/include
    ${CMAKE_CURRENT_SOURCE_DIR}/third_party
)

target_compile_options(ddos_server PRIVATE -O3 -pthread -Wall -Wextra)
target_link_libraries(ddos_server PRIVATE pthread)

add_executable(ddos_botnet
    src/main_botnet.cpp
)

target_compile_options(ddos_botnet PRIVATE -O3 -pthread -Wall -Wextra)
target_link_libraries(ddos_botnet PRIVATE pthread)