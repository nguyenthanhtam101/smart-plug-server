
idf_component_register(SRCS "tcp_client_main.c"
                    INCLUDE_DIRS "."
                    REQUIRES nvs_flash esp_wifi esp_event esp_websocket_client driver esp_adc json protocol_examples_common wifi_provisioning)
