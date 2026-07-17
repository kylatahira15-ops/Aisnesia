"""
================================================================
  YOLO Camera Monitor Server
  Tugas Akhir — Balqis Kyla Tahira
  Port: 5000
  
  Cara pakai:
    pip install flask opencv-python ultralytics
    python app.py
================================================================
"""

from flask import Flask, render_template, Response, jsonify, request
from flask_cors import CORS
import cv2
import threading
import time
import datetime

app = Flask(__name__)
CORS(app)

# ── CONFIG ──────────────────────────────────────────
CAMERA_SOURCE = 0          # 0 = webcam laptop (default), ganti jika pakai CCTV/IP cam
YOLO_MODEL    = 'best.pt'  # model hasil training sendiri (taruh di folder yang sama dengan app.py)
CONFIDENCE    = 0.5
TARGET_CLASS  = None       # None = deteksi SEMUA kelas dari model custom (karena best.pt biasanya sudah khusus kapal)

# ── PERFORMANCE TUNING (penting untuk laptop tanpa GPU) ──
INFER_EVERY_N_FRAMES = 3      # jalankan YOLO setiap N frame (3 = ~3x lebih ringan)
INFER_IMG_SIZE       = 416    # ukuran gambar saat inference (lebih kecil = lebih cepat, default YOLO 640)
JPEG_QUALITY         = 70     # kualitas JPEG output (lebih rendah = streaming lebih ringan)

# ── STATE ────────────────────────────────────────────
state = {
    'running'     : False,
    'detected'    : False,
    'confidence'  : 0.0,
    'total_detect': 0,
    'total_alert' : 0,
    'detections' : [],
    'last_detect_time': 0,
    'fps'         : 0.0,
    'frame_count' : 0,
    'start_time'  : None,
    'last_detect' : None,
    'model_loaded': False,
    'error'       : None,
}

camera   = None
model    = None
lock     = threading.Lock()
out_frame = None

# ── LOAD MODEL ───────────────────────────────────────
def load_model():
    global model
    try:
        from ultralytics import YOLO
        model = YOLO(YOLO_MODEL)
        state['model_loaded'] = True
        print(f'[YOLO] Model {YOLO_MODEL} loaded ✓')
    except Exception as e:
        state['error'] = f'Gagal load model: {str(e)}'
        print(f'[YOLO] Error: {e}')

# ── CAMERA THREAD ────────────────────────────────────
def camera_loop():
    global camera, out_frame
    state['running']    = True
    state['start_time'] = time.time()
    fps_counter = 0
    fps_timer   = time.time()

    # Windows: MSMF backend sering bermasalah, coba DSHOW dulu (lebih stabil)
    camera = cv2.VideoCapture(CAMERA_SOURCE, cv2.CAP_DSHOW)
    if not camera.isOpened():
        print('[CAM] DSHOW gagal, mencoba backend default...')
        camera = cv2.VideoCapture(CAMERA_SOURCE)

    if not camera.isOpened():
        state['error']   = f'Kamera tidak bisa dibuka (source: {CAMERA_SOURCE}). Coba ganti CAMERA_SOURCE ke 1 atau 2 di app.py.'
        state['running'] = False
        print(f'[CAM] GAGAL: {state["error"]}')
        return

    # Set resolusi eksplisit (kadang membantu stabilkan MSMF/DSHOW)
    camera.set(cv2.CAP_PROP_FRAME_WIDTH, 640)
    camera.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)
    camera.set(cv2.CAP_PROP_FPS, 30)

    # Warm-up: kamera butuh waktu untuk siap setelah dibuka.
    # Coba baca beberapa frame awal, buang yang gagal, jangan langsung anggap error.
    print('[CAM] Warming up...')
    warmup_ok = False
    for attempt in range(30):  # coba selama ~3 detik
        ret, _ = camera.read()
        if ret:
            warmup_ok = True
            break
        time.sleep(0.1)

    if not warmup_ok:
        state['error']   = f'Kamera terbuka tapi tidak bisa membaca frame (source: {CAMERA_SOURCE}). Coba restart laptop atau ganti CAMERA_SOURCE.'
        state['running'] = False
        camera.release()
        print(f'[CAM] GAGAL: {state["error"]}')
        return

    print(f'[CAM] Kamera terbuka & siap (source: {CAMERA_SOURCE})')

    fail_count = 0
    last_result = {'boxes': [], 'detected': False, 'conf': 0.0}  # cache hasil deteksi untuk frame yang di-skip

    while state['running']:
        ret, frame = camera.read()
        if not ret:
            fail_count += 1
            if fail_count > 150:  # ~7.5 detik gagal terus → stop dan laporkan
                state['error'] = 'Kamera berhenti merespons. Coba restart server atau cek driver kamera.'
                print(f'[CAM] {state["error"]}')
                break
            time.sleep(0.05)
            continue

        state['frame_count'] += 1
        fps_counter += 1
        fail_count = 0  # reset, kamera merespons normal

        # FPS hitung setiap detik
        now = time.time()
        if now - fps_timer >= 1.0:
            state['fps'] = round(fps_counter / (now - fps_timer), 1)
            fps_counter  = 0
            fps_timer    = now

        # ── YOLO Detection (dengan frame-skip untuk performa) ──
        detected = False
        conf_val = 0.0

        run_inference = (state['frame_count'] % INFER_EVERY_N_FRAMES == 0)

        if model and state['model_loaded'] and run_inference:
            try:
                results = model(frame, conf=CONFIDENCE, imgsz=INFER_IMG_SIZE, verbose=False)
                boxes_to_draw = []
                for r in results:
                    for box in r.boxes:
                        cls_name = model.names[int(box.cls)]
                        conf     = float(box.conf)

                        # Jika TARGET_CLASS None → anggap semua deteksi dari model custom relevan
                        is_match = (TARGET_CLASS is None) or (TARGET_CLASS.lower() in cls_name.lower()) or (cls_name in ['boat','ship','vessel'])

                        if is_match:
                            detected = True
                            if conf > conf_val:
                                conf_val = conf

                        x1,y1,x2,y2 = map(int, box.xyxy[0])
                        boxes_to_draw.append((x1,y1,x2,y2,cls_name,conf,is_match))

                # simpan hasil terakhir supaya frame berikutnya (yang di-skip) tetap menampilkan box
                last_result['boxes']    = boxes_to_draw
                last_result['detected'] = detected
                last_result['conf']     = conf_val

            except Exception as e:
                print(f'[YOLO] Inference error: {e}')
        else:
            # Pakai hasil deteksi terakhir supaya box tidak "kedip" hilang di frame yang di-skip
            detected = last_result['detected']
            conf_val = last_result['conf']

        # Simpan daftar class name untuk di-poll actuator.js — stabil 3 detik
        if detected:
            detections_list = []
            seen = set()
            for (x1,y1,x2,y2,cls_name,conf,is_match) in last_result['boxes']:
                if cls_name not in seen:
                    seen.add(cls_name)
                    detections_list.append({'name': cls_name, 'confidence': conf})
            state['detections'] = detections_list
            state['last_detect_time'] = time.time()
        else:
            # Keep detections for 3 seconds after last detection
            if time.time() - state.get('last_detect_time', 0) < 3:
                pass
            else:
                state['detections'] = []

        # Gambar bounding box (dari hasil terbaru / cache)
        for (x1,y1,x2,y2,cls_name,conf,is_match) in last_result['boxes']:
            color = (0,255,136) if is_match else (0,200,255)
            cv2.rectangle(frame, (x1,y1), (x2,y2), color, 2)
            label = f'{cls_name} {conf:.0%}'
            cv2.putText(frame, label, (x1, y1-8),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.55, color, 2)

        # Update state
        prev_detected = state['detected']
        state['detected']   = detected
        state['confidence'] = round(conf_val, 3)

        if detected:
            state['total_detect'] += 1
            state['last_detect']   = datetime.datetime.now().strftime('%H:%M:%S')
            if not prev_detected:
                state['total_alert'] += 1

        # Overlay info di frame
        h, w = frame.shape[:2]
        overlay = frame.copy()
        cv2.rectangle(overlay, (0,0), (w,32), (6,16,32), -1)
        frame = cv2.addWeighted(overlay, 0.7, frame, 0.3, 0)

        status_txt = '● KAPAL TERDETEKSI' if detected else '○ MEMINDAI...'
        status_col = (0,255,136) if detected else (148,180,200)
        cv2.putText(frame, status_txt, (10,22),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.6, status_col, 2)
        cv2.putText(frame, f'FPS:{state["fps"]}  Frame:{state["frame_count"]}',
                    (w-200,22), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (100,150,140), 1)

        # Encode ke JPEG
        _, buf = cv2.imencode('.jpg', frame, [cv2.IMWRITE_JPEG_QUALITY, JPEG_QUALITY])
        with lock:
            out_frame = buf.tobytes()

    # Cleanup
    if camera:
        camera.release()
    state['running'] = False
    print('[CAM] Kamera dimatikan.')

cam_thread = None

def start_camera():
    global cam_thread
    if cam_thread and cam_thread.is_alive():
        return
    cam_thread = threading.Thread(target=camera_loop, daemon=True)
    cam_thread.start()

def stop_camera():
    state['running'] = False

# ── MJPEG STREAM ─────────────────────────────────────
def generate_frames():
    while True:
        with lock:
            frame = out_frame
        if frame is None:
            time.sleep(0.05)
            continue
        yield (b'--frame\r\n'
               b'Content-Type: image/jpeg\r\n'
               b'Content-Length: ' + str(len(frame)).encode() + b'\r\n\r\n' +
               frame + b'\r\n')
        time.sleep(0.04)  # ~25fps, sedikit lebih longgar agar tidak overload buffer browser

# ── ROUTES ───────────────────────────────────────────
@app.route('/')
def index():
    return render_template('index.html')

@app.route('/video_feed')
def video_feed():
    resp = Response(generate_frames(),
                    mimetype='multipart/x-mixed-replace; boundary=frame')
    resp.headers['Cache-Control'] = 'no-cache, no-store, must-revalidate'
    resp.headers['Pragma'] = 'no-cache'
    resp.headers['Expires'] = '0'
    return resp

@app.route('/api/status')
def api_status():
    uptime = 0
    if state['start_time']:
        uptime = int(time.time() - state['start_time'])
    return jsonify({
        **state,
        'uptime_sec': uptime,
        'timestamp' : datetime.datetime.now().isoformat(),
    })

@app.route('/api/detections')
def api_detections():
    return jsonify({'detections': state.get('detections', [])})

@app.route('/api/start', methods=['POST'])
def api_start():
    if not state['running']:
        state['frame_count']  = 0
        state['total_detect'] = 0
        state['total_alert']  = 0
        state['error']        = None
        start_camera()
    return jsonify({'ok': True, 'running': state['running']})

@app.route('/api/stop', methods=['POST'])
def api_stop():
    stop_camera()
    return jsonify({'ok': True, 'running': False})

@app.route('/api/config', methods=['GET','POST'])
def api_config():
    global CONFIDENCE, TARGET_CLASS, CAMERA_SOURCE
    if request.method == 'POST':
        data = request.json or {}
        if 'confidence' in data:
            CONFIDENCE    = float(data['confidence'])
        if 'target_class' in data:
            TARGET_CLASS  = data['target_class']
        if 'camera_source' in data:
            CAMERA_SOURCE = data['camera_source']
        return jsonify({'ok': True})
    return jsonify({
        'confidence'   : CONFIDENCE,
        'target_class' : TARGET_CLASS,
        'camera_source': CAMERA_SOURCE,
        'model'        : YOLO_MODEL,
    })

# ── BOOT ─────────────────────────────────────────────
if __name__ == '__main__':
    print('╔══════════════════════════════════════╗')
    print('║     YOLO Camera Monitor v1.0         ║')
    print('║     Balqis Kyla Tahira               ║')
    print('╠══════════════════════════════════════╣')
    print('║  Dashboard → http://localhost:5000   ║')
    print('║  Stream    → /video_feed             ║')
    print('║  API       → /api/status             ║')
    print('╚══════════════════════════════════════╝')
    load_model()
    start_camera()
    app.run(host='0.0.0.0', port=5000, debug=False, threaded=True)
