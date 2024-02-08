import glReset from '../vendor/gl-reset.js'

type GLBufferTarget = Parameters<WebGL2RenderingContext['bindBuffer']>[0]
type GLTextureTarget = Parameters<WebGL2RenderingContext['bindTexture']>[0]
type GLBufferData = Parameters<WebGL2RenderingContext['bufferData']>[1]
type GLBufferUsage = Parameters<WebGL2RenderingContext['bufferData']>[2]
export type GLBuffer = { target: GLBufferTarget, buffer: WebGLBuffer, usage: GLBufferUsage, dispose: () => void }
export type GLTexture = { target: GLTextureTarget, uniform: WebGLUniformLocation, texture: WebGLTexture, dispose: () => void }
export type GLShaders = { vertex: WebGLShader, fragment: WebGLShader }

export type GL = ReturnType<typeof initGL>

export function initGL(canvas: HTMLCanvasElement, options: WebGLContextAttributes = {}) {
  const gl = canvas.getContext('webgl2', options)!
  const reset = glReset(gl)
  gl.getExtension('EXT_color_buffer_float')
  gl.getExtension('OES_texture_float_linear')
  gl.getExtension('OES_standard_derivatives')
  gl.enable(gl.DEPTH_TEST)
  gl.depthFunc(gl.LESS)
  gl.depthMask(false)
  gl.enable(gl.BLEND)
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)

  let program: WebGLProgram

  const uniforms = new Proxy({}, {
    get(_, name: string) {
      const uniform = gl.getUniformLocation(program, name)
      if (uniform == null) {
        // We only warn and not throw because WebGL will silently ignore assignments to null locations.
        // TODO: maybe throw
        console.warn('Uniform not found or not in use:', name)
      }
      return uniform
    }
  }) as Record<string, WebGLUniformLocation>

  function createProgram(shaders: GLShaders) {
    const program = gl.createProgram()!
    const { vertex, fragment } = shaders
    gl.attachShader(program, vertex)
    gl.attachShader(program, fragment)
    gl.linkProgram(program)
    useProgram(program)
    return program
  }

  function useProgram(webglProgram: WebGLProgram) {
    gl.useProgram(program = webglProgram)
  }

  function use(webglProgram: WebGLProgram, vao: WebGLVertexArrayObject) {
    gl.useProgram(program = webglProgram)
    gl.bindVertexArray(vao)
  }

  function createShader(type: Parameters<WebGL2RenderingContext['createShader']>[0], src: string) {
    const shader = gl.createShader(type)!
    gl.shaderSource(shader, src.trim())
    gl.compileShader(shader)
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader)!)
    return shader
  }

  function createShaders(src: { vertex: string, fragment: string }): GLShaders {
    return {
      vertex: createShader(gl.VERTEX_SHADER, src.vertex),
      fragment: createShader(gl.FRAGMENT_SHADER, src.fragment),
    }
  }

  function deleteShaders(shaders: GLShaders) {
    gl.deleteShader(shaders.vertex)
    gl.deleteShader(shaders.fragment)
  }

  function bindVertexAttribBuffer<T extends Parameters<WebGL2RenderingContext['bindBuffer']>[0]>(target: T, buffer: WebGLBuffer, name: string) {
    const index = gl.getAttribLocation(program, name)!
    gl.bindBuffer(target, buffer)
    gl.bindAttribLocation(program, index, name)
    gl.enableVertexAttribArray(index)
    return index
  }

  function addVertexAttrib<T extends GLBufferTarget>(
    target: T,
    name: string,
    attribFn: (attrib: number, target: T) => void
  ) {
    const buffer = gl.createBuffer()!
    const index = bindVertexAttribBuffer(target, buffer, name)
    attribFn(index, target)
    gl.bindBuffer(target, null)
    return buffer
  }

  function addVertexAttribs<
    T extends GLBufferTarget,
    U extends Record<string, [
      target: T,
      attribFn: (attrib: number, target: T) => void,
      usage?: GLBufferUsage
    ]>>(
      attribs: {
        [K in keyof U]: U[K]
      }
    ): {
      [K in keyof U]: GLBuffer
    } {
    const vertexAttribsBuffers: Record<string, GLBuffer> = {}
    for (const [name, [target, attribFn, usage = gl.STATIC_DRAW]] of Object.entries(attribs)) {
      const buffer = addVertexAttrib(target, name, attribFn)
      vertexAttribsBuffers[name] = {
        target,
        buffer,
        usage,
        dispose: () => {
          gl.deleteBuffer(buffer)
        }
      }
    }
    return vertexAttribsBuffers as any
  }

  const TEXTURE_MAX_ANISOTROPY_EXT = 0x84FE
  const texFloats = new Set<number>([
    TEXTURE_MAX_ANISOTROPY_EXT,
    gl.TEXTURE_MAX_LOD,
    gl.TEXTURE_MIN_LOD,
  ])

  function createTexture<T extends GLTextureTarget>(
    target: T,
    uniform: WebGLUniformLocation,
    params: Record<GLenum, GLenum | GLint | GLfloat>
  ): GLTexture {
    const texture = gl.createTexture()!
    gl.bindTexture(target, texture)
    for (const [name, param] of Object.entries(params)) {
      gl[`texParameter${texFloats.has(+name) ? 'f' : 'i'}`](target, +name, param)
    }
    function dispose() {
      gl.deleteTexture(texture)
    }
    return { target, uniform, texture, dispose }
  }

  function deleteTextures(textures: GLTexture[]) {
    for (const texture of textures) {
      texture.dispose()
    }
  }

  function activateTextures(textures: GLTexture[]) {
    for (let i = 0; i < textures.length; i++) {
      const { target, uniform, texture } = textures[i]
      gl.activeTexture(gl.TEXTURE0 + i)
      gl.bindTexture(target, texture)
      gl.uniform1i(uniform, i)
    }
  }

  function createVertexArray() {
    const vao = gl.createVertexArray()!
    gl.bindVertexArray(vao)
    return vao
  }

  function setBuffer<T extends GLBuffer>(
    buffer: T,
    data: GLBufferData,
    usage?: GLBufferUsage,
  ) {
    gl.bindBuffer(buffer.target, buffer.buffer)
    gl.bufferData(buffer.target, data, usage ?? buffer.usage)
  }

  function deleteAttribs(attribs: Record<string, GLBuffer>) {
    for (const attrib of Object.values(attribs)) {
      attrib.dispose()
    }
  }

  return {
    addVertexAttrib,
    addVertexAttribs,
    bindVertexAttribBuffer,
    deleteAttribs,
    setBuffer,
    createTexture,
    createProgram,
    createShader,
    createVertexArray,
    activateTextures,
    createShaders,
    deleteShaders,
    deleteTextures,
    gl,
    reset,
    uniforms,
    useProgram,
    use,
  }
}
