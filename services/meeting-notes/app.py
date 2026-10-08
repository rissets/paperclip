import json
import logging
import threading
from flask import Flask, jsonify
from flask_cors import CORS
from flask_sock import Sock
from config import Config
from models.schema import init_db
from routes.health import health_bp
from routes.meetings import meetings_bp
from core.live_stream_manager import live_stream_manager

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s"
)
logger = logging.getLogger("meeting_service")

def create_app() -> Flask:
    app = Flask(__name__)
    CORS(app, resources={r"/*": {"origins": "*"}})
    
    # Initialize DB schema
    init_db()
    
    # Register blueprints
    app.register_blueprint(health_bp)
    app.register_blueprint(meetings_bp)
    
    # Setup WebSocket
    sock = Sock(app)
    
    @sock.route("/ws/meetings/<meeting_id>/stream")
    def meeting_stream(ws, meeting_id):
        logger.info(f"WebSocket client connected for meeting: {meeting_id}")
        send_lock = threading.Lock()

        def safe_send_text(text: str):
            with send_lock:
                try:
                    if ws.connected:
                        ws.send(text)
                except Exception as send_err:
                    logger.debug(f"ws safe_send error: {send_err}")

        def on_analysis_update(analysis: dict):
            safe_send_text(json.dumps({
                "type": "analysis",
                "analysis": analysis
            }))

        session = live_stream_manager.get_or_create_session(meeting_id, ws_callback=on_analysis_update)
        
        try:
            while True:
                data = ws.receive()
                if data is None:
                    break
                    
                # If message is binary (audio chunk)
                if isinstance(data, (bytes, bytearray)):
                    result = session.process_audio_chunk(data)
                    if result:
                        payload = {
                            "type": "segment",
                            "segment": result["segment"],
                        }
                        if result.get("analysis"):
                            payload["analysis"] = result["analysis"]
                        safe_send_text(json.dumps(payload))
                # If message is text (control event)
                elif isinstance(data, str):
                    try:
                        ctrl = json.loads(data)
                        if ctrl.get("action") == "finish":
                            logger.info(f"Finish action received for meeting: {meeting_id}")
                            final_path = live_stream_manager.close_session(meeting_id)
                            safe_send_text(json.dumps({
                                "type": "finished",
                                "audio_path": str(final_path) if final_path else None
                            }))
                            break
                    except Exception as e:
                        logger.warning(f"Error handling text control message: {e}")
        except Exception as e:
            logger.error(f"WebSocket error in meeting {meeting_id}: {e}")
        finally:
            logger.info(f"WebSocket client disconnected for meeting: {meeting_id}")
            
    return app

app = create_app()

if __name__ == "__main__":
    logger.info(f"Starting Primbon Meeting Notes Service on {Config.HOST}:{Config.PORT}...")
    app.run(host=Config.HOST, port=Config.PORT, debug=Config.DEBUG)
