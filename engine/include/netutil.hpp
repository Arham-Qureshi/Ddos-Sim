#pragma once

#include <string>

// strict dotted-quad check: four 0..255 octets, nothing else
inline bool valid_ipv4(const std::string& s) {
    int octet = -1;
    int dots = 0;
    for (char ch : s) {
        if (ch == '.') {
            if (octet < 0 || octet > 255) {
                return false;
            }
            octet = -1;
            ++dots;
        } else if (ch >= '0' && ch <= '9') {
            if (octet < 0) {
                octet = 0;
            }
            octet = octet * 10 + (ch - '0');
            if (octet > 255) {
                return false;
            }
        } else {
            return false;
        }
    }
    return octet >= 0 && octet <= 255 && dots == 3;
}