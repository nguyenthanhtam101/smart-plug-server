#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <math.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/event_groups.h"
#include "esp_log.h"
#include "esp_wifi.h"
#include "esp_event.h"
#include "nvs_flash.h"
#include "driver/gpio.h"
#include "esp_adc/adc_oneshot.h"
#include "esp_websocket_client.h"
#include "cJSON.h"
#include "esp_timer.h"

// --- THƯ VIỆN WIFI PROVISIONING ---
#include "wifi_provisioning/manager.h"
#include "wifi_provisioning/scheme_ble.h"

static const char *TAG = "SMART_PLUG";

// --- CẤU HÌNH ---
#define WS_URI "wss://mysmartplug.onrender.com"
#define PROV_DEVICE_NAME   "PRO_SMART_PLUG"         // Tên Bluetooth khi quét
#define PROV_POP           "123456"                 // MẬT KHẨU ĐỂ KẾT NỐI (Proof of Possession)

// --- CHÂN PIN (ESP32-C3) ---
#define RELAY_PIN      GPIO_NUM_4
#define BUTTON_PIN     GPIO_NUM_3
#define ADC_UNIT       ADC_UNIT_1
#define ADC_CHANNEL    ADC_CHANNEL_0 

// --- CẤU HÌNH ĐO LƯỜNG ---
#define ADC_REF_VOLTAGE    3.3
#define ADC_RESOLUTION     4095.0
#define ACS712_SENSITIVITY 0.185 
#define CALIBRATION_FACTOR 2.17    
#define SYSTEM_NOISE_FLOOR 0.18     
#define VOLTAGE_AC         220.0

static esp_websocket_client_handle_t client = NULL;
static bool is_light_on = false;
adc_oneshot_unit_handle_t adc1_handle;
const int WIFI_CONNECTED_EVENT = BIT0;
static EventGroupHandle_t wifi_event_group;

// --- KHAI BÁO HÀM ---
void send_sensor_data(void);
void start_application(void); // Hàm chạy logic chính sau khi có Wifi

// --- 1. CÁC HÀM ĐO ĐẠC & LOGIC (GIỮ NGUYÊN NHƯ CŨ) ---
static void adc_init_config(void) {
    adc_oneshot_unit_init_cfg_t init_config1 = { .unit_id = ADC_UNIT };
    adc_oneshot_new_unit(&init_config1, &adc1_handle);
    adc_oneshot_chan_cfg_t config = { .bitwidth = ADC_BITWIDTH_DEFAULT, .atten = ADC_ATTEN_DB_12 };
    adc_oneshot_config_channel(adc1_handle, ADC_CHANNEL, &config);
}

float read_current_rms() {
    // (Giữ nguyên code đo dòng điện và lọc nhiễu của bạn ở đây)
    // Để cho gọn tôi viết tóm tắt, bạn copy lại nội dung hàm read_current_rms xịn nhất vào đây nhé
    int adc_raw;
    double sum_sq = 0;
    long sample_count = 0;
    long sum_adc = 0;
    for(int i=0; i<100; i++) {
        ESP_ERROR_CHECK(adc_oneshot_read(adc1_handle, ADC_CHANNEL, &adc_raw));
        sum_adc += adc_raw;
    }
    double dynamic_zero = (double)sum_adc / 100.0;
    int64_t start_time = esp_timer_get_time();
    while ((esp_timer_get_time() - start_time) < 500000) { 
        ESP_ERROR_CHECK(adc_oneshot_read(adc1_handle, ADC_CHANNEL, &adc_raw));
        double adc_delta = (double)adc_raw - dynamic_zero;
        double voltage_delta = (adc_delta * ADC_REF_VOLTAGE) / 4095.0;
        double current_inst = voltage_delta / ACS712_SENSITIVITY;
        sum_sq += (current_inst * current_inst);
        sample_count++;
        esp_rom_delay_us(10);
    }
    if (sample_count == 0) return 0.0;
    double measured_rms = sqrt(sum_sq / sample_count);
    double real_rms = 0.0;
    if (measured_rms > SYSTEM_NOISE_FLOOR) {
        double val = (measured_rms * measured_rms) - (SYSTEM_NOISE_FLOOR * SYSTEM_NOISE_FLOOR);
        if (val > 0) real_rms = sqrt(val);
    }
    real_rms *= CALIBRATION_FACTOR;
    return (float)real_rms;
}

void send_sensor_data(void) {
    if (client == NULL || !esp_websocket_client_is_connected(client)) return;
    float raw_power = 0.0, raw_current = 0.0;
    if (is_light_on) {
        raw_current = read_current_rms();
        raw_power = VOLTAGE_AC * raw_current;
    }
    float power = (int)(raw_power * 100 + 0.5) / 100.0;
    float current = (int)(raw_current * 100 + 0.5) / 100.0;

    cJSON *root = cJSON_CreateObject();
    cJSON_AddStringToObject(root, "deviceId", "lamp_01");
    cJSON_AddNumberToObject(root, "power", power);
    cJSON_AddNumberToObject(root, "current", current);
    cJSON_AddStringToObject(root, "state", is_light_on ? "ON" : "OFF");
    char *json_string = cJSON_PrintUnformatted(root);
    esp_websocket_client_send_text(client, json_string, strlen(json_string), portMAX_DELAY);
    cJSON_Delete(root);
    free(json_string);
}

void button_task(void *pvParameters) {
    gpio_config_t io_conf = {
        .pin_bit_mask = (1ULL << BUTTON_PIN),
        .mode = GPIO_MODE_INPUT,
        .pull_up_en = 1,
        .pull_down_en = 0,
        .intr_type = GPIO_INTR_DISABLE
    };
    gpio_config(&io_conf);
    int last_state = 1;
    while(1) {
        int current_state = gpio_get_level(BUTTON_PIN);
        if (last_state == 1 && current_state == 0) {
            vTaskDelay(pdMS_TO_TICKS(50)); 
            if (gpio_get_level(BUTTON_PIN) == 0) {
                is_light_on = !is_light_on;
                gpio_set_level(RELAY_PIN, is_light_on ? 0 : 1);
                send_sensor_data();
                while(gpio_get_level(BUTTON_PIN) == 0) vTaskDelay(pdMS_TO_TICKS(10));
            }
        }
        last_state = current_state;
        vTaskDelay(pdMS_TO_TICKS(10));
    }
}

static void websocket_event_handler(void *handler_args, esp_event_base_t base, int32_t event_id, void *event_data) {
    esp_websocket_event_data_t *data = (esp_websocket_event_data_t *)event_data;
    switch (event_id) {
        case WEBSOCKET_EVENT_CONNECTED: ESP_LOGI(TAG, "CONNECTED!"); break;
        case WEBSOCKET_EVENT_DATA:
            if (data->op_code == WS_TRANSPORT_OPCODES_TEXT) {
                char *buf = calloc(1, data->data_len + 1);
                memcpy(buf, data->data_ptr, data->data_len);
                cJSON *json = cJSON_Parse(buf);
                if (json) {
                    cJSON *action = cJSON_GetObjectItem(json, "action");
                    if (cJSON_IsString(action) && (strcmp(action->valuestring, "control") == 0)) {
                        cJSON *state = cJSON_GetObjectItem(json, "state");
                        if (cJSON_IsString(state)) {
                            if (strcmp(state->valuestring, "ON") == 0) {
                                is_light_on = true;
                                gpio_set_level(RELAY_PIN, 0); 
                            } else {
                                is_light_on = false;
                                gpio_set_level(RELAY_PIN, 1);
                            }
                            send_sensor_data();
                        }
                    }
                    cJSON_Delete(json);
                }
                free(buf);
            }
            break;
    }
}

void measurement_task(void *pvParameters) {
    while (1) {
        send_sensor_data();
        vTaskDelay(pdMS_TO_TICKS(2000));
    }
}

// --- 2. XỬ LÝ SỰ KIỆN WIFI & PROVISIONING (PHẦN MỚI) ---

static void event_handler(void* arg, esp_event_base_t event_base, int32_t event_id, void* event_data) {
    if (event_base == WIFI_EVENT && event_id == WIFI_EVENT_STA_START) {
        esp_wifi_connect();
    } else if (event_base == WIFI_EVENT && event_id == WIFI_EVENT_STA_DISCONNECTED) {
        esp_wifi_connect(); // Tự kết nối lại nếu mất mạng
        ESP_LOGI(TAG, "Retrying to connect to the AP");
    } else if (event_base == IP_EVENT && event_id == IP_EVENT_STA_GOT_IP) {
        ip_event_got_ip_t* event = (ip_event_got_ip_t*) event_data;
        ESP_LOGI(TAG, "Got IP: " IPSTR, IP2STR(&event->ip_info.ip));
        xEventGroupSetBits(wifi_event_group, WIFI_CONNECTED_EVENT);
    } else if (event_base == WIFI_PROV_EVENT) {
        switch (event_id) {
            case WIFI_PROV_START: ESP_LOGI(TAG, "Provisioning started"); break;
            case WIFI_PROV_CRED_RECV: ESP_LOGI(TAG, "Received Wi-Fi credentials"); break;
            case WIFI_PROV_CRED_FAIL: ESP_LOGI(TAG, "Provisioning failed!"); break;
            case WIFI_PROV_CRED_SUCCESS: ESP_LOGI(TAG, "Provisioning successful"); break;
            case WIFI_PROV_END: 
                esp_wifi_set_storage(WIFI_STORAGE_FLASH); // Lưu pass wifi vĩnh viễn
                wifi_prov_mgr_deinit(); 
                break;
            default: break;
        }
    }
}

static void wifi_init_sta(void) {
    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    esp_netif_create_default_wifi_sta();
    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&cfg));

    ESP_ERROR_CHECK(esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID, &event_handler, NULL));
    ESP_ERROR_CHECK(esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP, &event_handler, NULL));
    ESP_ERROR_CHECK(esp_event_handler_register(WIFI_PROV_EVENT, ESP_EVENT_ANY_ID, &event_handler, NULL));

    wifi_event_group = xEventGroupCreate();
}

// --- 3. HÀM CHẠY APP CHÍNH (ĐƯỢC GỌI SAU KHI CÓ WIFI) ---
void start_application(void) {
    ESP_LOGI(TAG, "WIFI OK -> KHOI CHAY SMART PLUG LOGIC...");

    // Cấu hình GPIO
    gpio_reset_pin(RELAY_PIN);
    gpio_set_direction(RELAY_PIN, GPIO_MODE_OUTPUT);
    gpio_set_level(RELAY_PIN, 1); 
    adc_init_config();

    // WebSocket
    esp_websocket_client_config_t websocket_cfg = { .uri = WS_URI };
    client = esp_websocket_client_init(&websocket_cfg);
    esp_websocket_register_events(client, WEBSOCKET_EVENT_ANY, websocket_event_handler, (void *)client);
    esp_websocket_client_start(client);

    // Tasks
    xTaskCreate(measurement_task, "measure_task", 4096, NULL, 5, NULL);
    xTaskCreate(button_task, "button_task", 2048, NULL, 5, NULL);
}

void app_main(void) {
    // 1. Khởi tạo NVS (Để lưu Wifi)
    esp_err_t ret = nvs_flash_init();
    if (ret == ESP_ERR_NVS_NO_FREE_PAGES || ret == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        ret = nvs_flash_init();
    }
    ESP_ERROR_CHECK(ret);

    // 2. Khởi tạo Wifi & Provisioning
    wifi_init_sta();

    wifi_prov_mgr_config_t config = {
        .scheme = wifi_prov_scheme_ble, // Dùng BLE để cấu hình
        .scheme_event_handler = WIFI_PROV_SCHEME_BLE_EVENT_HANDLER_FREE_BTDM
    };

    bool provisioned = false;
    ESP_ERROR_CHECK(wifi_prov_mgr_init(config));
    ESP_ERROR_CHECK(wifi_prov_mgr_is_provisioned(&provisioned));

    if (!provisioned) {
        ESP_LOGI(TAG, "CHUA CO WIFI -> BAT BLE PROVISIONING...");
        
        // Bắt đầu phát BLE để App tìm thấy
        // Dịch vụ: "PRO_SMART_PLUG", Mật khẩu POP: "123456"
        ESP_ERROR_CHECK(wifi_prov_mgr_start_provisioning(
            WIFI_PROV_SECURITY_1, 
            PROV_POP, 
            PROV_DEVICE_NAME, 
            NULL));
            
        // --- THAY BẰNG ĐOẠN NÀY ---
ESP_LOGI(TAG, "---------------------------------------------------");
ESP_LOGI(TAG, "Scan this QR Code to provision:");
// In ra đường link để bạn có thể click vào xem QR trên máy tính
ESP_LOGI(TAG, "Link QR: https://espressif.github.io/esp-launchpad/qrcode.html?data={\"ver\":\"v1\",\"name\":\"%s\",\"pop\":\"%s\",\"transport\":\"ble\"}", PROV_DEVICE_NAME, PROV_POP);

// In ra chuỗi JSON gốc (để bạn copy làm mã QR dán lên sản phẩm)
ESP_LOGI(TAG, "Raw JSON: {\"ver\":\"v1\",\"name\":\"%s\",\"pop\":\"%s\",\"transport\":\"ble\"}", PROV_DEVICE_NAME, PROV_POP);
ESP_LOGI(TAG, "---------------------------------------------------");
    } else {
        ESP_LOGI(TAG, "DA CO WIFI -> KET NOI...");
        ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
        ESP_ERROR_CHECK(esp_wifi_start());
    }

    // 3. Chờ có IP thì mới chạy ứng dụng
    xEventGroupWaitBits(wifi_event_group, WIFI_CONNECTED_EVENT, true, false, portMAX_DELAY);
    
    // 4. Có IP rồi -> Chạy App chính
    start_application();
}