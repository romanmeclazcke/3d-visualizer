# Plan Detection Backend

Backend Python para análisis geométrico de planos 2D sin IA. Está pensado como base para una pipeline más avanzada y ya resuelve:

- preprocesado de imagen con `OpenCV`
- detección de contorno exterior
- detección de muros interiores por líneas
- eliminación de duplicados cercanos al perímetro
- estimación automática de escala
- detección de habitaciones cerradas por componentes conectados
- salida semántica en JSON

## Stack

- `FastAPI`
- `OpenCV`
- `NumPy`
- `Pydantic`
- `Docker`

## Estructura

```text
app/
  geometry.py      # preprocesado y detección geométrica
  image_loader.py  # carga de PNG/JPG/WEBP/PDF
  main.py          # API HTTP
  models.py        # contratos de entrada/salida
  pipeline.py      # orquestación del análisis
Dockerfile
docker-compose.yml
requirements.txt
```

## Ejecutar local

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

## Ejecutar con Docker

```bash
docker compose up --build
```

## Endpoint principal

`POST /analyze/file`

Sube un archivo de plano y devuelve un `parsed_plan` con:

- `outline`
- `walls`
- `rooms`
- `issues`
- `scale`
- `wall_thickness_px`
- `debug`

Ejemplo con `curl`:

```bash
curl -X POST "http://localhost:8000/analyze/file" \
  -H "accept: application/json" \
  -H "Content-Type: multipart/form-data" \
  -F "file=@./sample-plan.png"
```

## Notas

- La rama PDF está preparada, pero todavía no rasteriza contenido vectorial real. Si quieres soporte PDF serio, lo siguiente es integrar `PyMuPDF` o `Poppler`.
- No hay detección automática de puertas, ventanas ni objetos todavía. La arquitectura ya deja sitio para añadir esa capa después.
