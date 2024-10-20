import glReset from '../vendor/gl-reset.js'

export type GLAttribFn<T, U extends GLBufferData | undefined> = (attrib: number, target: T, usage: GLBufferUsage) => U
export type GLAttribParam<T, U extends GLBufferData | undefined> = [
  target: T,
  attribFn: GLAttribFn<T, U>,
  usage?: GLBufferUsage
]
export type GLBufferTarget = Parameters<WebGL2RenderingContext['bindBuffer']>[0]
export type GLTextureTarget = Parameters<WebGL2RenderingContext['bindTexture']>[0]
export type GLBufferData = Parameters<WebGL2RenderingContext['bufferData']>[1]
export type GLBufferUsage = Parameters<WebGL2RenderingContext['bufferData']>[2]
export type GLBuffer<T extends GLBufferData | undefined = GLBufferData> = {
  target: GLBufferTarget
  usage: GLBufferUsage
  buffer: WebGLBuffer
  data: T
  ptr: number
  dispose: () => void
}
export type GLTexture = {
  target: GLTextureTarget
  uniform: WebGLUniformLocation
  texture: WebGLTexture
  dispose: () => void
}
export type GLShaders = { vertex: WebGLShader, fragment: WebGLShader }

export type GL = ReturnType<typeof initGL>

export const typedArrayConstructors = [
  Uint8Array,
  Uint16Array,
  Uint32Array,
  BigUint64Array,
  Int8Array,
  Int16Array,
  Int32Array,
  BigInt64Array,
  Float32Array,
  Float64Array,
]

export type TypedArrayConstructor = typeof typedArrayConstructors[0]

export type TypedArray<T extends TypedArrayConstructor> = InstanceType<T>

export function initGL(canvas: HTMLCanvasElement, options: WebGLContextAttributes = {}) {
  const gl = canvas.getContext('webgl2', options)!
  const reset = glReset(gl)
  gl.getExtension('EXT_color_buffer_float')
  gl.getExtension('OES_texture_float_linear')
  gl.getExtension('OES_standard_derivatives')
  gl.enable(gl.DEPTH_TEST)
  gl.enable(gl.SCISSOR_TEST)
  gl.depthFunc(gl.LESS)
  gl.depthMask(false)
  gl.enable(gl.BLEND)
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)

  let currentProgram: WebGLProgram
  let currentVao: WebGLVertexArrayObject

  const uniforms = new Proxy({}, {
    get(_, name: string) {
      const uniform = gl.getUniformLocation(currentProgram, name)
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

  function useProgram(program: WebGLProgram) {
    if (program !== currentProgram) {
      gl.useProgram(currentProgram = program)
    }
  }

  function useVao(vao: WebGLVertexArrayObject) {
    if (vao !== currentVao) {
      gl.bindVertexArray(currentVao = vao)
    }
  }

  function use(webglProgram: WebGLProgram, vao: WebGLVertexArrayObject) {
    useProgram(webglProgram)
    useVao(vao)
  }

  function createShader(type: Parameters<WebGL2RenderingContext['createShader']>[0], src: string | ((gl: WebGL2RenderingContext) => string)) {
    const shader = gl.createShader(type)!
    gl.shaderSource(shader, (typeof src === 'function' ? src(gl) : src).trim())
    gl.compileShader(shader)
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader)!)
    return shader
  }

  function createShaders(src: { vertex: string | ((gl: WebGL2RenderingContext) => string), fragment: string | ((gl: WebGL2RenderingContext) => string) }): GLShaders {
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
    const index = gl.getAttribLocation(currentProgram, name)
    if (index === -1) {
      console.warn('Attribute not found or not in use:', name)
      return
    }
    gl.bindBuffer(target, buffer)
    gl.bindAttribLocation(currentProgram, index, name)
    gl.enableVertexAttribArray(index)
    return index
  }

  function addVertexAttrib<T extends GLBufferTarget, U extends undefined | GLBufferData>(
    target: T,
    name: string,
    attribFn: GLAttribFn<T, U>,
    usage?: GLBufferUsage
  ) {
    const buffer = gl.createBuffer()!
    using _ = useBuffer(target, buffer)
    const index = bindVertexAttribBuffer(target, buffer, name)
    if (index == null) return { buffer }
    const data = attribFn(index, target, usage ?? gl.STATIC_DRAW)
    return { buffer, data }
  }

  function addVertexAttribs<
    T extends GLBufferTarget,
    U extends Record<string, [
      target: T,
      attribFn: GLAttribFn<T, V>,
      usage?: GLBufferUsage
    ]>,
    V extends undefined | GLBufferData
  >(
    attribs: {
      [K in keyof U]: U[K]
    }
  ): {
      [K in keyof U]: GLBuffer<ReturnType<U[K][1]>>
    } {
    const vertexAttribsBuffers: Record<string, GLBuffer<any>> = {}
    for (const [name, [target, attribFn, usage = gl.STATIC_DRAW]] of Object.entries(attribs)) {
      const { buffer, data } = addVertexAttrib(target, name, attribFn, usage)
      vertexAttribsBuffers[name] = {
        target,
        buffer,
        data,
        ptr: data?.byteOffset ?? 0,
        usage,
        dispose: () => {
          gl.deleteBuffer(buffer)
        }
      }
    }
    return vertexAttribsBuffers as any
  }

  const bufferDisposables = {
    [gl.ARRAY_BUFFER]: {
      [Symbol.dispose]() {
        gl.bindBuffer(gl.ARRAY_BUFFER, null)
      }
    }
  } as Record<number, Disposable>

  function useBuffer<T extends GLBufferTarget>(target: T, buffer: WebGLBuffer) {
    gl.bindBuffer(target, buffer)
    return bufferDisposables[target]
  }

  function useArrayBuffer(buffer: WebGLBuffer) {
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    return bufferDisposables[gl.ARRAY_BUFFER]
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

  function deleteAttribs(attribs: Record<string, GLBuffer<any>>) {
    for (const attrib of Object.values(attribs)) {
      attrib.dispose()
    }
  }

  function bufferSubData({ buffer, target }: GLBuffer, data: GLBufferData, offset: number = 0) {
    using _ = useBuffer(target, buffer)
    gl.bufferSubData(target, offset, data)
  }

  const memoized = new WeakMap<GLBuffer, Map<number, TypedArray<any>>>()
  function getDataRange(attrib: GLBuffer<any>, range: { begin: number, end: number, count: number }) {
    const r = range
    const index = r.begin << 2
    const length = r.count << 2
    const begin = index
    const end = index + length

    const PRIME = 31
    const hash = begin * PRIME + end
    let mem = memoized.get(attrib)
    if (!mem) memoized.set(attrib, mem = new Map)
    let subarray = mem.get(hash)
    if (!subarray) mem.set(hash, subarray = attrib.data.subarray(begin, end))
    return subarray
  }

  function writeAttribRange(attrib: GLBuffer<any>, range: { begin: number, end: number, count: number }) {
    bufferSubData(attrib, getDataRange(attrib, range))
  }

  const typedCtorToGLTypeMap = new Map<TypedArrayConstructor, GLenum>([
    [Float32Array, gl.FLOAT],
    [Int32Array, gl.INT],
  ])

  const intPointerTypes = new Set<TypedArrayConstructor>([Int32Array])

  function attrib<
    T extends GLBufferTarget,
    U extends TypedArray<V>,
    V extends TypedArrayConstructor,
  >(size: number, data: U, divisor?: number): GLAttribFn<T, U>
  function attrib<
    T extends GLBufferTarget,
    U extends TypedArray<V>,
    V extends TypedArrayConstructor,
  >(size: number, fn: () => U, divisor?: number): GLAttribFn<T, U>
  function attrib<
    T extends GLBufferTarget,
    U extends TypedArray<V>,
    V extends TypedArrayConstructor,
  >(size: number, fnOrData: U | (() => U), divisor: number = 0): GLAttribFn<T, U> {
    return (index, target: T, usage) => {
      const data = typeof fnOrData === 'function' ? fnOrData() : fnOrData
      gl.bufferData(target, data.length * data.BYTES_PER_ELEMENT, usage)
      gl.bufferData(target, data, usage)
      if (divisor) gl.vertexAttribDivisor(index, divisor)
      const type = typedCtorToGLTypeMap.get(data.constructor as V)!
      if (intPointerTypes.has(data.constructor as V)) {
        gl.vertexAttribIPointer(index, size, type, 0, 0)
      }
      else {
        gl.vertexAttribPointer(index, size, type, false, 0, 0)
      }
      return data
    }
  }

  return {
    activateTextures,
    addVertexAttrib,
    addVertexAttribs,
    attrib,
    bindVertexAttribBuffer,
    bufferSubData,
    canvas,
    createProgram,
    createShader,
    createShaders,
    createTexture,
    createVertexArray,
    deleteAttribs,
    deleteShaders,
    deleteTextures,
    gl,
    reset,
    setBuffer,
    uniforms,
    use,
    useArrayBuffer,
    useBuffer,
    useProgram,
    useVao,
    writeAttribRange,
  }
}
